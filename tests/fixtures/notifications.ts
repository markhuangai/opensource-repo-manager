import { createServer, type IncomingHttpHeaders } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SMTPServer } from "smtp-server";

export async function notificationFixture(
  root: string,
  options: {
    secure?: boolean;
    noStartTls?: boolean;
    key?: string;
    cert?: string;
  } = {},
) {
  if (!options.key)
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-days",
        "1",
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "ca.pem"),
      ],
      { stdio: "ignore" },
    );
  const key = await readFile(options.key ?? join(root, "key.pem"));
  const cert = await readFile(options.cert ?? join(root, "ca.pem"));
  const requests: Array<{
    path: string;
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
  }> = [];
  const modes: Record<
    string,
    {
      status?: number;
      lose?: boolean;
      hold?: boolean;
      headers?: Record<string, string>;
      body?: string;
    }
  > = {};
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = request.url!;
    requests.push({
      path,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >,
      headers: request.headers,
    });
    const mode = modes[path] ?? {};
    if (mode.lose) {
      request.socket.destroy();
      return;
    }
    if (mode.hold) return;
    response.writeHead(mode.status ?? 204, mode.headers);
    response.end(mode.body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const auth: Array<{
    username: string | undefined;
    password: string | null | undefined;
    secure: boolean;
  }> = [];
  const messages: Array<{ raw: string; to: string[] }> = [];
  const rejected = new Map<string, number>();
  const state = { hold: false, lose: false, auth_code: 0 };
  const smtp = new SMTPServer({
    key,
    cert,
    secure: options.secure ?? true,
    logger: false,
    disabledCommands: options.noStartTls ? ["STARTTLS"] : [],
    onAuth(authentication, session, callback) {
      auth.push({
        username: authentication.username,
        password: authentication.password,
        secure: session.secure,
      });
      if (state.auth_code) {
        callback(
          Object.assign(new Error("Synthetic authentication refusal"), {
            responseCode: state.auth_code,
          }),
        );
        return;
      }
      callback(null, { user: authentication.username });
    },
    onRcptTo(address, _session, callback) {
      const code = rejected.get(address.address);
      callback(
        code
          ? Object.assign(new Error("Synthetic recipient refusal"), {
              responseCode: code,
            })
          : null,
      );
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        messages.push({
          raw: Buffer.concat(chunks).toString(),
          to: session.envelope.rcptTo.map((address) => address.address),
        });
        if (state.lose) {
          for (const connection of smtp.connections)
            if (connection.id === session.id) connection.close();
          return;
        }
        if (!state.hold) callback();
      });
    },
  });
  smtp.on("error", () => {});
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const address = http.address(),
    smtpAddress = smtp.server.address();
  if (
    !address ||
    typeof address === "string" ||
    !smtpAddress ||
    typeof smtpAddress === "string"
  )
    throw new Error("Fixture address unavailable");
  return {
    requests,
    modes,
    messages,
    rejected,
    state,
    auth,
    cert,
    url: `http://127.0.0.1:${address.port}`,
    smtp: {
      enabled: true as const,
      host: "localhost",
      port: smtpAddress.port,
      secure: options.secure ?? true,
      username: "fixture-smtp-user",
      password: "fixture-smtp-password",
      from: "manager@example.invalid",
      to: ["first@example.invalid", "second@example.invalid"],
    },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      for (const connection of smtp.connections) connection.close();
      await new Promise<void>((resolve) => smtp.close(resolve));
    },
  };
}
