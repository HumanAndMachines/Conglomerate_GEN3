import { describe, expect, test } from "bun:test";
import {
  isSessionResetCommand,
  normalizeZulipContent,
} from "../../bridge/inbound/content.ts";
import { downloadRuntimeImage } from "../../bridge/outbound/zulip.ts";
import { createRuntimeReplyProvider } from "../../bridge/runtime-adapter/http-client.ts";

describe("rendered Zulip content", () => {
  test("recognises reset commands after Zulip rendered them as HTML", () => {
    const content = normalizeZulipContent("<p>/reset</p>");
    expect(content.text).toBe("/reset");
    expect(isSessionResetCommand(content.text)).toBeTrue();
    expect(isSessionResetCommand("/new")).toBeTrue();
  });

  test("extracts private inline images and keeps readable text", () => {
    const content = normalizeZulipContent(
      '<p>koukni</p><div><img src="/user_uploads/1/a/test.png"></div>',
    );
    expect(content).toEqual({
      text: "koukni",
      imageUrls: ["/user_uploads/1/a/test.png"],
    });
  });

  test("extracts the raw Markdown upload shape used by the event queue", () => {
    const content = normalizeZulipContent(
      "koukni [test.png](/user_uploads/1/a/test.png)",
    );
    expect(content).toEqual({
      text: "koukni test.png",
      imageUrls: ["/user_uploads/1/a/test.png"],
    });
  });
});

describe("authenticated Zulip images", () => {
  test("fetches only same-realm uploads with bot auth and returns a data URL", async () => {
    let authorization = "";
    let calls = 0;
    const result = await downloadRuntimeImage({
      site: "https://realm.test",
      botEmail: "bot@realm.test",
      botApiKey: "secret",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          authorization = String(new Headers(init?.headers).get("authorization"));
          return Response.json({
            result: "success",
            url: "/user_uploads/temporary/signed",
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      }) as typeof fetch,
    }, "/user_uploads/1/a/test.png");
    expect(authorization).toStartWith("Basic ");
    expect(calls).toBe(2);
    expect(result).toBe("data:image/png;base64,AQID");
  });

  test("refuses arbitrary and cross-origin URLs", async () => {
    const cfg = {
      site: "https://realm.test",
      botEmail: "bot@realm.test",
      botApiKey: "secret",
      fetchImpl: (async () => new Response()) as typeof fetch,
    };
    await expect(downloadRuntimeImage(cfg, "https://evil.test/image.png")).rejects.toThrow(
      /outside this Zulip realm/,
    );
  });
});

test("runtime receives actual multimodal content, not a private browser URL", async () => {
  let body: any;
  const provider = createRuntimeReplyProvider({
    endpoint: "http://127.0.0.1:8642/v1/chat/completions",
    apiKey: "k",
    model: "hermes",
    systemMessage: () => "contract",
    loadImage: async () => "data:image/png;base64,AQID",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "vidim" } }] });
    }) as typeof fetch,
  });
  await provider({
    text: "co je na obrazku?",
    imageUrls: ["/user_uploads/1/a/test.png"],
    senderName: "Principal",
    trigger: "direct_message",
    conversationKind: "private",
    sessionId: "session",
    messageId: 1,
    replyTarget: { kind: "private", recipientEmails: ["p@realm.test"] },
  });
  expect(body.messages[1].content).toEqual([
    { type: "text", text: "co je na obrazku?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
  ]);
});

