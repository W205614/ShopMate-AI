import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createCipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  WechatGateway,
  AlipayGateway,
  cents,
  parseBill,
} from "../src/production/payment-providers";
import type { Payment, Refund } from "../../shared/domain/production";

const merchantKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const platformKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keyId = "PUB_KEY_ID_1234567890",
  apiKey = "12345678901234567890123456789012";
const payment: Payment = {
  id: "SMp0123456789abcdef0123456789ab",
  orderId: "SMfixture",
  userId: "fixture",
  provider: "wechatpay",
  merchantId: "123456",
  channel: "wechat_native",
  amount: 12345,
  currency: "CNY",
  status: "pending",
  closeRequested: false,
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const refund: Refund = {
  id: "SMr0123456789abcdef0123456789ab",
  paymentId: payment.id,
  orderId: payment.orderId,
  afterSaleId: "sale",
  provider: "wechatpay",
  amount: 2345,
  status: "pending",
  attempts: 0,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
};
let server: Server,
  base: string,
  invalidSignature = false,
  beforeH5Response: (() => void) | undefined;
const captured: {
  url: string;
  method: string;
  body: Record<string, unknown>;
  verified: boolean;
}[] = [];
const billText = `交易时间,商户订单号,订单金额,手续费\n\`2026-11-05,\`${payment.id},\`123.45,\`0.50\n`;
function verifyAlipayRequest(params: Record<string, string>) {
  const content = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return verify(
    "RSA-SHA256",
    Buffer.from(content),
    merchantKeys.publicKey,
    Buffer.from(params.sign ?? "", "base64"),
  );
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(),
      url = req.url!;
    if (url.startsWith("/gateway.do")) {
      const params = Object.fromEntries([
        ...new URL(url, base).searchParams,
        ...new URLSearchParams(raw),
      ]);
      const biz = JSON.parse(params.biz_content ?? "{}");
      captured.push({
        url,
        method: String(params.method),
        body: biz,
        verified: verifyAlipayRequest(params),
      });
      let body: Record<string, unknown>;
      if (params.method === "alipay.trade.query")
        body = {
          code: "10000",
          msg: "Success",
          out_trade_no: payment.id,
          trade_no: "alipay-fixture",
          seller_id: "2088000000000000",
          total_amount: "123.45",
          trade_status: "TRADE_SUCCESS",
          send_pay_date: "2026-11-06 20:00:00",
        };
      else if (params.method === "alipay.trade.refund")
        body = {
          code: "10000",
          msg: "Success",
          out_trade_no: payment.id,
          trade_no: "alipay-fixture",
          refund_fee: "23.45",
          gmt_refund_pay: "2026-11-06 20:00:00",
          fund_change: "Y",
        };
      else
        body = {
          code: "10000",
          msg: "Success",
          out_trade_no: payment.id,
          out_request_no: refund.id,
          trade_no: "alipay-fixture",
          refund_amount: "23.45",
          refund_status: "REFUND_SUCCESS",
          gmt_refund_pay: "2026-11-06 20:00:00",
        };
      const bodyText = JSON.stringify(body),
        responseKey = String(params.method).replaceAll(".", "_") + "_response";
      res.setHeader("Content-Type", "application/json");
      res.end(
        `{"${responseKey}":${bodyText},"sign":"${sign("RSA-SHA256", Buffer.from(invalidSignature ? "forged response" : bodyText), platformKeys.privateKey).toString("base64")}"}`,
      );
      return;
    }
    const auth = Object.fromEntries(
      [...String(req.headers.authorization).matchAll(/\b(\w+)="([^"]*)"/g)].map(
        (match) => [match[1], match[2]],
      ),
    );
    const verified = verify(
      "RSA-SHA256",
      Buffer.from(
        `${req.method}\n${url}\n${auth.timestamp}\n${auth.nonce_str}\n${raw}\n`,
      ),
      merchantKeys.publicKey,
      Buffer.from(auth.signature ?? "", "base64"),
    );
    captured.push({
      url,
      method: req.method!,
      body: raw ? JSON.parse(raw) : {},
      verified,
    });
    if (url.startsWith("/v3/billdownload/file")) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(billText);
      return;
    }
    let body: Record<string, unknown>;
    if (url.startsWith("/v3/bill/tradebill"))
      body = {
        download_url:
          "https://api.mch.weixin.qq.com/v3/billdownload/file?token=fixture",
        hash_type: "SHA1",
        hash_value: createHash("sha1").update(billText).digest("hex"),
      };
    else if (url.endsWith("/native"))
      body = { code_url: "weixin://wxpay/bizpayurl?pr=fixture" };
    else if (url.endsWith("/h5")) {
      beforeH5Response?.();
      body = {
        h5_url:
          "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=fixture",
      };
    } else if (url.includes("/refund/"))
      body = {
        out_trade_no: payment.id,
        out_refund_no: refund.id,
        refund_id: "wx-refund",
        status: "SUCCESS",
        success_time: "2026-11-06T12:00:00+08:00",
        amount: {
          total: payment.amount,
          refund: refund.amount,
          currency: "CNY",
        },
      };
    else
      body = {
        out_trade_no: payment.id,
        mchid: payment.merchantId,
        appid: "wx-fixture",
        trade_state: "SUCCESS",
        success_time: "2026-11-06T12:00:00+08:00",
        transaction_id: "wx-transaction",
        amount: { total: payment.amount, currency: "CNY" },
      };
    const bodyText = JSON.stringify(body),
      timestamp = String(Math.floor(Date.now() / 1000)),
      nonce = randomBytes(16).toString("hex");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Wechatpay-Serial", keyId);
    res.setHeader("Wechatpay-Timestamp", timestamp);
    res.setHeader("Wechatpay-Nonce", nonce);
    res.setHeader(
      "Wechatpay-Signature",
      invalidSignature
        ? "invalid"
        : sign(
            "RSA-SHA256",
            Buffer.from(`${timestamp}\n${nonce}\n${bodyText}\n`),
            platformKeys.privateKey,
          ).toString("base64"),
    );
    res.end(bodyText);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const wechat = () =>
  new WechatGateway({
    merchantId: payment.merchantId,
    appId: "wx-fixture",
    serial: "MERCHANT_SERIAL",
    privateKey: merchantKeys.privateKey,
    publicKeys: { [keyId]: platformKeys.publicKey },
    apiKey,
    publicUrl: "https://shop.example.test",
    baseURL: base,
  });
const alipay = () =>
  new AlipayGateway({
    appId: "2026000000000000",
    merchantId: "2088000000000000",
    privateKey: merchantKeys.privateKey,
    publicKey: platformKeys.publicKey,
    publicUrl: "https://shop.example.test",
    gateway: `${base}/gateway.do`,
  });

describe("real payment adapters against HTTP protocol peers", () => {
  it("signs WeChat requests, verifies responses and supports Native/H5/query/refund", async () => {
    const gateway = wechat(),
      input = {
        description: "测试订单",
        ip: "203.0.113.1",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    expect((await gateway.create(payment, input)).kind).toBe("qr");
    expect(
      await gateway.create({ ...payment, channel: "wechat_h5" }, input),
    ).toMatchObject({ kind: "redirect", expiresAt: input.expiresAt });
    expect((await gateway.query(payment))?.status).toBe("succeeded");
    expect((await gateway.refund(refund, payment)).amount).toBe(refund.amount);
    expect((await gateway.queryRefund(refund))?.status).toBe("succeeded");
    const calls = captured.filter((item) => item.url.startsWith("/v3/"));
    expect(calls.every((item) => item.verified)).toBe(true);
    expect(
      calls.find((item) => item.url.endsWith("/native"))!.body,
    ).toMatchObject({
      out_trade_no: payment.id,
      notify_url: "https://shop.example.test/api/webhooks/wechatpay",
      amount: { total: 12345, currency: "CNY" },
    });
    invalidSignature = true;
    await expect(gateway.query(payment)).rejects.toThrow(
      "WECHAT_REQUEST_FAILED",
    );
    invalidSignature = false;
  });
  it("bounds H5 checkout lifetime by five minutes from request start, not response completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    beforeH5Response = () => vi.setSystemTime(start + 2000);
    try {
      const checkout = await wechat().create(
        { ...payment, channel: "wechat_h5" },
        {
          description: "H5时效验收",
          ip: "203.0.113.1",
          expiresAt: new Date(start + 10 * 60_000).toISOString(),
        },
      );
      expect(checkout.expiresAt).toBe(
        new Date(start + 5 * 60_000).toISOString(),
      );
      expect(Date.now()).toBe(start + 2000);
      expect(captured.at(-1)).toMatchObject({
        url: "/v3/pay/transactions/h5",
        verified: true,
        body: {
          out_trade_no: payment.id,
          time_expire: new Date(start + 10 * 60_000).toISOString(),
        },
      });
    } finally {
      beforeH5Response = undefined;
      vi.useRealTimers();
    }
  });
  it("verifies exact WeChat callback bytes, timestamp, key ID and encrypted resource", () => {
    const gateway = wechat();
    const plaintext = JSON.stringify({
      out_trade_no: payment.id,
      mchid: payment.merchantId,
      appid: "wx-fixture",
      transaction_id: "wx-paid",
      success_time: "2026-11-06T12:00:00+08:00",
      amount: { total: payment.amount, currency: "CNY" },
    });
    const nonce = "123456789012",
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(apiKey),
        Buffer.from(nonce),
      );
    cipher.setAAD(Buffer.from("transaction"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
    const raw = Buffer.from(
      JSON.stringify({
        id: "callback-fixture",
        event_type: "TRANSACTION.SUCCESS",
        resource: {
          algorithm: "AEAD_AES_256_GCM",
          nonce,
          associated_data: "transaction",
          ciphertext,
        },
      }),
    );
    const timestamp = String(Math.floor(Date.now() / 1000)),
      headers = {
        "wechatpay-serial": keyId,
        "wechatpay-timestamp": timestamp,
        "wechatpay-nonce": "fixture-nonce",
        "wechatpay-signature": sign(
          "RSA-SHA256",
          Buffer.from(`${timestamp}\nfixture-nonce\n${raw}\n`),
          platformKeys.privateKey,
        ).toString("base64"),
      };
    expect(gateway.webhook(raw, headers).result).toMatchObject({
      amount: payment.amount,
      status: "succeeded",
    });
    expect(() =>
      gateway.webhook(Buffer.concat([raw, Buffer.from(" ")]), headers),
    ).toThrow("WEBHOOK_SIGNATURE_INVALID");
    expect(() =>
      gateway.webhook(raw, { ...headers, "wechatpay-serial": "unknown" }),
    ).toThrow("WEBHOOK_SIGNATURE_INVALID");
    expect(() =>
      gateway.webhook(raw, { ...headers, "wechatpay-timestamp": "1" }),
    ).toThrow("WEBHOOK_SIGNATURE_INVALID");
  });
  it("uses Alipay SDK for signed desktop/WAP checkouts and signed query/refund responses", async () => {
    const gateway = alipay(),
      input = {
        description: "测试订单",
        expiresAt: "2026-11-06T12:00:00.000Z",
      };
    const result = await gateway.create(
      { ...payment, provider: "alipay", channel: "alipay_page" },
      input,
    );
    const params = new URL(result.value).searchParams;
    expect(params.get("method")).toBe("alipay.trade.page.pay");
    expect(verifyAlipayRequest(Object.fromEntries(params))).toBe(true);
    const content = JSON.parse(params.get("biz_content")!);
    expect(content).toMatchObject({
      out_trade_no: payment.id,
      total_amount: "123.45",
      time_expire: "2026-11-06 20:00:00",
    });
    expect(params.get("return_url")).toBe(
      `https://shop.example.test/orders/${payment.orderId}/pay`,
    );
    expect(
      new URL(
        (await gateway.create({ ...payment, channel: "alipay_wap" }, input))
          .value,
      ).searchParams.get("method"),
    ).toBe("alipay.trade.wap.pay");
    expect((await gateway.query(payment))?.status).toBe("succeeded");
    expect((await gateway.refund(refund, payment)).status).toBe("succeeded");
    expect((await gateway.queryRefund(refund, payment))?.amount).toBe(
      refund.amount,
    );
    expect(
      captured
        .filter((entry) => entry.url.startsWith("/gateway.do"))
        .every((entry) => entry.verified),
    ).toBe(true);
    invalidSignature = true;
    try {
      await expect(gateway.query(payment)).rejects.toThrow();
    } finally {
      invalidSignature = false;
    }
  });
  it("rejects forged Alipay notifications and duplicate fields, and verifies decimal amounts", () => {
    const gateway = alipay();
    const data: Record<string, string> = {
      app_id: "2026000000000000",
      seller_id: "2088000000000000",
      out_trade_no: payment.id,
      trade_no: "alipay-paid",
      total_amount: "123.45",
      trade_status: "TRADE_SUCCESS",
      gmt_payment: "2026-11-06 20:00:00",
      notify_id: "notify-fixture",
      sign_type: "RSA2",
    };
    const source = Object.keys(data)
      .filter((key) => key !== "sign_type")
      .sort()
      .map((key) => `${key}=${data[key]}`)
      .join("&");
    data.sign = sign(
      "RSA-SHA256",
      Buffer.from(source),
      platformKeys.privateKey,
    ).toString("base64");
    const raw = Buffer.from(new URLSearchParams(data).toString());
    expect(gateway.webhook(raw).result).toMatchObject({
      amount: 12345,
      status: "succeeded",
    });
    expect(() =>
      gateway.webhook(
        Buffer.from(
          new URLSearchParams({ ...data, total_amount: "999" }).toString(),
        ),
      ),
    ).toThrow("WEBHOOK_SIGNATURE_INVALID");
    expect(() =>
      gateway.webhook(
        Buffer.concat([raw, Buffer.from("&total_amount=123.45")]),
      ),
    ).toThrow("WEBHOOK_DUPLICATE_FIELDS");
    expect(cents("0.01")).toBe(1);
    expect(() => cents("1.001")).toThrow();
  });
  it("parses signed-channel bill amounts and rejects malformed bill headers", () => {
    const rows = parseBill(
      `交易时间,商户订单号,订单金额,手续费\n\`2026-11-05,\`${payment.id},\`123.45,\`0.50\n总交易单数,总金额`,
      "wechatpay",
    );
    expect(rows).toEqual([
      { kind: "payment", merchantOrderNo: payment.id, amount: 12345, fee: 50 },
    ]);
    expect(() => parseBill("unknown,columns\na,b", "alipay")).toThrow(
      "BILL_FORMAT_INVALID",
    );
  });
  it("signs the bill download request and checks its authenticated metadata hash", async () => {
    const entries = await wechat().bill("2026-11-05");
    expect(entries[0]).toMatchObject({
      merchantOrderNo: payment.id,
      amount: 12345,
      fee: 50,
    });
    expect(
      captured.find((call) => call.url.startsWith("/v3/billdownload/file"))!
        .verified,
    ).toBe(true);
  });
  it("distinguishes refund bill rows and preserves returned fee signs", () => {
    const alipayRows = parseBill(
      `商户订单号,业务类型,订单金额（元）,退款批次号/请求号,服务费（元）\n${payment.id},退款,-23.45,${refund.id},-0.10`,
      "alipay",
    );
    expect(alipayRows).toEqual([
      {
        kind: "refund",
        merchantOrderNo: payment.id,
        merchantRefundNo: refund.id,
        amount: 2345,
        fee: -10,
      },
    ]);
    expect(() =>
      parseBill(
        `商户订单号,交易状态,申请退款金额\n${payment.id},REFUND,23.45`,
        "wechatpay",
      ),
    ).toThrow("BILL_REFUND_ID_MISSING");
  });
});
