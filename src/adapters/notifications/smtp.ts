import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { createTransport } from "nodemailer";
import { digest } from "../../domain/agents.ts";
import type { Configuration } from "../../config/schema.ts";
import type {
  DeliveryResult,
  NotificationChannel,
} from "../../services/notifications/contracts.ts";

type Settings = Extract<
  Configuration["notifications"]["smtp"],
  { enabled: true }
>;
export class SmtpNotificationChannel implements NotificationChannel {
  readonly binding: string;
  readonly recipients: number;
  private readonly settings: Settings;
  private readonly trust: Pick<ConnectionOptions, "ca">;
  constructor(settings: Settings, trust: Pick<ConnectionOptions, "ca"> = {}) {
    this.settings = settings;
    this.trust = trust;
    this.binding = digest({ version: 1, kind: "smtp", settings });
    this.recipients = settings.to.length;
  }

  async deliver(
    event: Parameters<NotificationChannel["deliver"]>[0],
    signal: AbortSignal,
  ): Promise<DeliveryResult> {
    signal.throwIfAborted();
    const config = this.settings;
    const permanentRecipients = (errors: unknown) =>
      event.recipients.filter(
        (index) =>
          Array.isArray(errors) &&
          errors.some(
            (error: unknown) =>
              error !== null &&
              typeof error === "object" &&
              "recipient" in error &&
              error.recipient === config.to[index] &&
              "responseCode" in error &&
              Number(error.responseCode) >= 500,
          ),
      );
    let socket: Socket | undefined;
    const abort = () => socket?.destroy();
    signal.addEventListener("abort", abort, { once: true });
    const transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure,
      tls: { ...this.trust, rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: { user: config.username, pass: config.password },
      logger: false,
      debug: false,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
      disableFileAccess: true,
      disableUrlAccess: true,
      getSocket: (_options, callback) => {
        if (signal.aborted)
          return callback(new Error("notification_cancelled"), false);
        let returned = false;
        const done = (error?: Error) => {
          if (returned) return;
          returned = true;
          if (error)
            callback(
              Object.assign(new Error("notification_connection_failed"), {
                code:
                  config.secure &&
                  /CERT|TLS|SELF_SIGNED|VERIFY/.test(
                    "code" in error ? String(error.code) : "",
                  )
                    ? "ETLS"
                    : "ECONNECTION",
              }),
              false,
            );
          else callback(null, { connection: socket!, secured: config.secure });
        };
        const options = { host: config.host, port: config.port, signal };
        socket = config.secure
          ? tlsConnect({
              ...options,
              ...this.trust,
              servername: config.host,
              rejectUnauthorized: true,
              minVersion: "TLSv1.2",
            })
          : tcpConnect(options);
        socket.once(config.secure ? "secureConnect" : "connect", () => done());
        socket.once("error", (error) => done(error));
      },
    });
    try {
      const info = await transport.sendMail({
        from: config.from,
        to: event.recipients.map((index) => config.to[index]),
        subject: String(event.payload.subject),
        text: String(event.payload.text),
        messageId: `<${digest(event.id)}@opensource-repo-manager.invalid>`,
        date: new Date(Number(event.payload.occurred_at)),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const accepted = event.recipients.filter((index) =>
        info.accepted.includes(config.to[index]),
      );
      const rejected = permanentRecipients(info.rejectedErrors);
      return {
        outcome:
          accepted.length === event.recipients.length
            ? "confirmed"
            : rejected.length + accepted.length === event.recipients.length
              ? "permanent"
              : "transient",
        code:
          accepted.length === event.recipients.length
            ? "accepted"
            : "smtp_rejected",
        accepted,
        rejected,
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      const response =
        error && typeof error === "object" && "responseCode" in error
          ? Number(error.responseCode)
          : 0;
      const rejected = permanentRecipients(
        error && typeof error === "object" && "rejectedErrors" in error
          ? error.rejectedErrors
          : undefined,
      );
      if (response >= 400 && response < 500)
        return { outcome: "transient", code: "smtp_rejected", rejected };
      if (code === "ETLS" || code === "EAUTH" || response >= 500)
        return {
          outcome: "permanent",
          code: code === "ETLS" ? "smtp_tls_failed" : "smtp_rejected",
          rejected: event.recipients,
        };
      return {
        outcome: "uncertain",
        code: signal.aborted ? "interrupted" : "network_failure",
      };
    } finally {
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      transport.close();
    }
  }
}
