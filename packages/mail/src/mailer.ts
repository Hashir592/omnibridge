import { createTransport, type Transporter } from 'nodemailer';
import { lintEmail, type Email } from './templates.ts';

/** The single sender for system email (MAIL-2). */
export const SYSTEM_FROM = 'OmniBridge <notifications@omnibridge.co.uk>';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise STARTTLS is required unless `allowPlain` is set. */
  secure: boolean;
  user?: string;
  /** Read from a Docker secret file by the caller, never from an env value (SEC-5). */
  password?: string;
  /** Dev only: Mailpit speaks plain SMTP on the internal network. */
  allowPlain?: boolean;
}

/**
 * SMTP adapter (ADR-020): Scaleway TEM in production, Mailpit in dev. Every email passes the
 * template lint before it leaves, so buyer PII markers and secrets are refused, not sent.
 */
export class Mailer {
  readonly #transport: Transporter;

  constructor(config: SmtpConfig) {
    this.#transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && config.allowPlain !== true,
      ignoreTLS: config.allowPlain === true,
      ...(config.user === undefined
        ? {}
        : { auth: { user: config.user, pass: config.password ?? '' } }),
    });
  }

  async send(to: string, email: Email): Promise<string> {
    lintEmail(email);
    const info = await this.#transport.sendMail({
      from: SYSTEM_FROM,
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return info.messageId;
  }

  close(): void {
    this.#transport.close();
  }
}
