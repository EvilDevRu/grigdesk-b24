import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { TrackerError } from '../types/contract.ts';
import { isRecord, redactSecrets } from './objects.ts';

export interface PasswordCredentials {
  origin: string;
  authMode: 'password';
  login: string;
  password: string;
}

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const CHALLENGE_MESSAGE = 'Требуется код/капча — войдите в портал и повторите';

/**
 * Коды отказа REST сообщают о проблеме сессии, а не самих данных.
 * session_failed облачные порталы сопровождают новым токеном для повтора.
 */
const AUTH_ERRORS
  = /^(NO_AUTH|NO_AUTH_FOUND|AUTH_ERROR|ERROR_SESSION_EXPIRED|SESSION_EXPIRED|INVALID_CSRF|INVALID_SESSID|session_failed)$/iu;

/**
 * Форма с проверочным кодом требует участия человека и завершает подключение сразу.
 * Проверяем реальные поля формы и виджеты капчи до любого повторного входа.
 */
function assertNoChallenge(html: string): void {
  const field = /(?:name|id)\s*=\s*["'](?:captcha\w*|USER_OTP|OTP|SECURITY_CODE|AUTH_CHECKWORD)["']/iu;

  if (field.test(html) || /g-recaptcha|h-captcha|двухфакторн|одноразов[а-я\s]*код/iu.test(html)) {
    throw new TrackerError('tracker_auth_challenge', CHALLENGE_MESSAGE);
  }
}

/**
 * Куки принадлежат одному набору реквизитов и одному origin портала.
 * Формат файла сверяет отпечаток, поэтому смена аккаунта не подхватывает прежнюю сессию.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();
  private readonly path: string;
  private readonly signature: string;

  /**
   * Загружает только собственный формат с совпадающим отпечатком реквизитов.
   * Отсутствующий или повреждённый файл приводит к обычному входу через форму.
   */
  constructor(path: string, credentials: PasswordCredentials) {
    this.path = path;
    this.signature = createHash('sha256').update(JSON.stringify(credentials)).digest('hex');

    try {
      const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));

      if (isRecord(stored) && stored.signature === this.signature && isRecord(stored.cookies)) {
        for (const [key, value] of Object.entries(stored.cookies)) {
          if (typeof value === 'string') {
            this.cookies.set(key, value);
          }
        }
      }
    } catch {
      // Первый вход и повреждённый кеш не мешают подключению.
    }
  }

  /**
   * Собирает Set-Cookie при каждом ответе, включая перенаправления и ротацию.
   * Удалённые куки не возвращаются порталу при следующем запросе.
   */
  absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      if (separator < 1 || !name) {
        continue;
      }

      if (!value || value === 'deleted' || /;\s*max-age=0(?:;|$)/iu.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }

  /**
   * Сохраняет только куки и отпечаток; пароль и sessid не записываются.
   * Файл сессии создаётся с доступом только владельцу процесса.
   */
  persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({
      signature: this.signature,
      cookies: Object.fromEntries(this.cookies),
    }), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

/**
 * Самостоятельная копия формы входа и cookie jar из сессионного драйвера discript.
 * Страницей возврата служит корень портала; локальные AJAX discript не требуются.
 */
export class PasswordAuth {
  private readonly credentials: PasswordCredentials;
  private readonly transport: typeof fetch;
  private readonly jar: CookieJar;
  private sessid: string | null = null;
  private refererUrl: string | null = null;

  /**
   * Состояние принадлежит одному экземпляру и точному набору реквизитов.
   * Транспорт передаёт host, импорты других пакетов авторизации отсутствуют.
   */
  constructor(credentials: PasswordCredentials, cookiePath: string, transport: typeof fetch) {
    this.credentials = credentials;
    this.transport = transport;
    this.jar = new CookieJar(cookiePath, credentials);
  }

  /**
   * Все запросы ограничены одним origin и сроком, включая переходы после логина.
   * Автоматический redirect отключён, чтобы куки и реквизиты не ушли другому сайту.
   */
  private async raw(path: string, options: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.credentials.origin);

    if (url.origin !== this.credentials.origin || url.username || url.password) {
      throw new TrackerError('tracker_auth_error', 'Портал перенаправил вход на другой адрес');
    }

    const response = await this.transport(url.href, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: this.jar.header(),
        ...options.headers,
      },
    });

    this.jar.absorb(response.headers);

    return response;
  }

  /**
   * Переходы формы сохраняют куки, но не повторяют POST с паролем.
   * Ограничение числа переходов завершает ошибочную цепочку без зацикливания.
   */
  private async page(response: Response): Promise<string> {
    for (let hop = 0; response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get('location');

      if (!location || hop >= 5) {
        throw new TrackerError('tracker_auth_error', 'Не удалось завершить переходы формы входа');
      }

      await response.body?.cancel();
      response = await this.raw(new URL(location, response.url || this.credentials.origin).href);
    }

    if (!response.ok) {
      throw new TrackerError('tracker_auth_error', 'Портал отклонил форму входа');
    }

    this.refererUrl = response.url || this.refererUrl;

    const html = await response.text();

    assertNoChallenge(html);

    return html;
  }

  /**
   * Форма пароля означает отказ авторизации, установленные куки — действующую сессию.
   * Облачные SPA-страницы не обязаны содержать bitrix_sessid: недостающий токен
   * REST получает из отказа портала, поэтому null — допустимое состояние.
   */
  private acceptSession(html: string): boolean {
    if (/name\s*=\s*["']USER_PASSWORD["']/iu.test(html) || !this.jar.header()) {
      return false;
    }

    this.sessid = html.match(/["']?bitrix_sessid["']?\s*[:=]\s*["']([a-z0-9]+)["']/iu)?.[1]
      ?? this.sessid;
    this.jar.persist();

    return true;
  }

  /**
   * Вход отправляет ту же форму AUTH, что проверенный сессионный клиент.
   * Капча, код и неверные реквизиты завершают операцию после одной отправки.
   */
  private async login(): Promise<void> {
    this.sessid = null;
    this.jar.clear();

    const form = new URLSearchParams({
      AUTH_FORM: 'Y',
      TYPE: 'AUTH',
      backurl: '/',
      USER_LOGIN: this.credentials.login,
      USER_PASSWORD: this.credentials.password,
      USER_REMEMBER: 'Y',
    });

    try {
      const response = await this.raw('/?login=yes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: this.credentials.origin,
          Referer: this.credentials.origin + '/',
        },
        body: form.toString(),
      });
      let html = await this.page(response);

      if (!/name\s*=\s*["']USER_PASSWORD["']/iu.test(html) && !this.acceptSession(html)) {
        html = await this.page(await this.raw('/'));
      }

      if (!this.acceptSession(html)) {
        throw new TrackerError('tracker_auth_error', 'Логин не удался: проверьте логин и пароль');
      }
    } catch (error) {
      this.jar.clear();
      this.jar.persist();

      throw error;
    }
  }

  /**
   * Куки с диска проверяются страницей портала перед первым REST-запросом.
   * После успешного входа sessid кешируется до явного отказа сессии.
   */
  private async ensureSession(): Promise<void> {
    if (this.sessid) {
      return;
    }

    if (this.jar.header() && this.acceptSession(await this.page(await this.raw('/')))) {
      return;
    }

    await this.login();
  }

  /**
   * Убирает пароль, CSRF и значения куки из диагностического текста REST.
   * Состояние сессии остаётся внутри транспорта и не передаётся вызывающему коду.
   */
  redact(message: string): string {
    const cookies = this.jar.header().split('; ').map((pair) => pair.slice(pair.indexOf('=') + 1));

    return redactSecrets(message, [this.credentials.password, this.sessid, ...cookies]);
  }

  /**
   * Плоская форма повторяет браузерный клиент: sessid первым параметром,
   * вложенные поля — в квадратных скобках, значения — строками.
   */
  private formBody(fields: Record<string, unknown>): string {
    const params = new URLSearchParams({ sessid: this.sessid ?? '' });

    const flatten = (value: unknown, prefix: string): void => {
      if (value === null || value === undefined) {
        params.append(prefix, '');
      } else if (Array.isArray(value)) {
        value.forEach((child, index) => flatten(child, `${prefix}[${index}]`));
      } else if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          flatten(child, `${prefix}[${key}]`);
        }
      } else {
        params.append(prefix, String(value));
      }
    };

    for (const [key, value] of Object.entries(fields)) {
      flatten(value, key);
    }

    return params.toString();
  }

  /**
   * REST повторяет браузерный транспорт: форма вместо JSON, X-Requested-With и Referer.
   * Просроченный sessid облачный портал возвращает в отказе session_failed — повтор
   * с новым токеном выполняется до перевхода, как в штатном rest.client.
   */
  async request(method: string, fields: Record<string, unknown>): Promise<Response> {
    await this.ensureSession();

    let reloginDone = false;
    let sessidRetries = 0;

    for (;;) {
      const response = await this.raw(`/rest/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: this.credentials.origin,
          Referer: this.refererUrl ?? `${this.credentials.origin}/`,
        },
        body: this.formBody(fields),
      });
      const text = await response.clone().text();

      assertNoChallenge(text);

      const data: unknown = await response.clone().json().catch(() => null);
      const error = isRecord(data) && typeof data.error === 'string' ? data.error : null;
      const loginPage = /name\s*=\s*["']USER_PASSWORD["']/iu.test(text);
      const authCode = error !== null && AUTH_ERRORS.test(error);
      const portalError = isRecord(data) && (Boolean(data.error) || Boolean(data.error_description));
      const freshSessid = isRecord(data) && typeof data.sessid === 'string' && data.sessid
        ? data.sessid : null;

      if (freshSessid && (error === 'session_failed' || authCode) && sessidRetries < 2) {
        this.sessid = freshSessid;
        sessidRetries += 1;
        await response.body?.cancel();

        continue;
      }

      if (!authCode && !loginPage && (response.status !== 401 || portalError)) {
        this.jar.persist();

        return response;
      }

      await response.body?.cancel();

      if (reloginDone) {
        this.sessid = null;
        this.jar.clear();
        this.jar.persist();

        throw new TrackerError('tracker_auth_error', 'Портал не подтвердил сессию после входа');
      }

      reloginDone = true;
      await this.login();
    }
  }
}
