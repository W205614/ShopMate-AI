import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { AlipaySdk } from "alipay-sdk";
import { Wechatpay, Aes } from "wechatpay-axios-plugin";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import { z } from "zod";
import type {
  Payment,
  PaymentChannel,
  PaymentProvider,
  Refund,
} from "../../../shared/domain/production";
import { secret } from "./config";

export class GatewayError extends Error {
  constructor(
    public code: string,
    public ambiguous = false,
  ) {
    super(code);
  }
}
export interface PaymentResult {
  merchantOrderNo: string;
  merchantId: string;
  amount: number;
  currency: "CNY";
  status: "pending" | "succeeded" | "closed" | "failed";
  providerTransactionId?: string;
  succeededAt?: string;
}
export interface RefundResult {
  merchantRefundNo: string;
  merchantOrderNo: string;
  amount: number;
  status: "processing" | "succeeded" | "failed" | "abnormal";
  providerRefundId?: string;
  succeededAt?: string;
}
export interface BillEntry {
  kind: "payment" | "refund";
  merchantOrderNo: string;
  merchantRefundNo?: string;
  amount: number;
  fee: number;
}
export interface GatewayEvent {
  id: string;
  kind: "payment" | "refund";
  result: PaymentResult | RefundResult;
}
export interface PaymentGateway {
  provider: PaymentProvider;
  merchantId: string;
  create(
    payment: Payment,
    input: { description: string; expiresAt: string; ip: string },
  ): Promise<NonNullable<Payment["checkout"]>>;
  query(payment: Payment): Promise<PaymentResult | null>;
  close(payment: Payment): Promise<void>;
  refund(refund: Refund, payment: Payment): Promise<RefundResult>;
  queryRefund(refund: Refund, payment: Payment): Promise<RefundResult | null>;
  webhook(raw: Buffer, headers: IncomingHttpHeaders): GatewayEvent;
  bill(date: string): Promise<BillEntry[]>;
}

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export function cents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new GatewayError("PROVIDER_AMOUNT_INVALID");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new GatewayError("PROVIDER_AMOUNT_INVALID");
  return Number(amount);
}
export const decimal = (amount: number) =>
  `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
function successTime(value: unknown, alipay = false) {
  const raw = z.string().parse(value);
  const normalized = alipay ? `${raw.replace(" ", "T")}+08:00` : raw;
  const checked = z.iso.datetime({ offset: true }).parse(normalized);
  return new Date(checked).toISOString();
}
const required = (name: string) => {
  const value = secret(name);
  if (!value)
    throw new Error(`${name} is required for the enabled payment provider`);
  return value;
};
const keyFile = (name: string) => readFileSync(required(name), "utf8");

/** Download URLs are provider responses, not an authority to fetch arbitrary hosts. */
async function download(
  url: string,
  allowed: RegExp,
  digest?: string,
  hashType?: string,
) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !allowed.test(target.hostname)
  )
    throw new GatewayError("BILL_URL_INVALID");
  const response = await fetch(target, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (
    !response.ok ||
    Number(response.headers.get("content-length") ?? 0) > 20 * 1024 * 1024
  )
    throw new GatewayError("BILL_DOWNLOAD_FAILED", true);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body!) {
    bytes += chunk.length;
    if (bytes > 20 * 1024 * 1024) {
      await response.body?.cancel().catch(() => undefined);
      throw new GatewayError("BILL_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (
    digest &&
    (!hashType ||
      !["SHA1", "SHA256"].includes(hashType) ||
      createHash(hashType.toLowerCase()).update(buffer).digest("hex") !==
        digest)
  )
    throw new GatewayError("BILL_DIGEST_INVALID");
  return buffer;
}

export function parseBill(
  text: string,
  provider: PaymentProvider,
): BillEntry[] {
  const rows = parse(text.replace(/^\uFEFF/, ""), {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as string[][];
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => cell.replaceAll("`", "").trim() === "商户订单号"),
  );
  if (headerIndex < 0) throw new GatewayError("BILL_FORMAT_INVALID");
  const headers = rows[headerIndex]!.map((cell) =>
    cell.replaceAll("`", "").trim(),
  );
  const result: BillEntry[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const record = Object.fromEntries(
      headers.map((header, index) => [
        header,
        (row[index] ?? "").replaceAll("`", "").trim(),
      ]),
    );
    const orderNo = record["商户订单号"];
    if (!orderNo || !/^SMp[a-f0-9]{28}$/.test(orderNo)) continue;
    const refundNo =
      record["商户退款单号"] ||
      record["退款批次号/请求号"] ||
      record["商户业务号"];
    const kind =
      refundNo?.startsWith("SMr") ||
      record["交易状态"] === "REFUND" ||
      (provider === "alipay" && record["业务类型"]?.includes("退款"))
        ? "refund"
        : "payment";
    if (kind === "refund" && (!refundNo || refundNo === "0"))
      throw new GatewayError("BILL_REFUND_ID_MISSING");
    const value =
      kind === "refund"
        ? record["申请退款金额"] ||
          record["退款金额"] ||
          record["退款金额（元）"] ||
          (provider === "alipay" ? record["订单金额（元）"] : undefined)
        : record["订单金额"] ||
          record["总金额"] ||
          record["订单金额（元）"] ||
          record["应结订单金额"];
    if (!value) throw new GatewayError("BILL_AMOUNT_MISSING");
    const fee =
      record["手续费"] || record["服务费"] || record["服务费（元）"] || "0";
    result.push({
      kind,
      merchantOrderNo: orderNo,
      ...(kind === "refund" ? { merchantRefundNo: refundNo } : {}),
      amount: cents(value.replace(kind === "refund" ? /^[-+]/ : /^\+/, "")),
      fee: (fee.startsWith("-") ? -1 : 1) * cents(fee.replace(/^[-+]/, "")),
    });
  }
  // A valid empty bill is allowed; malformed headers are rejected above.
  return result;
}

export interface WechatOptions {
  appId: string;
  merchantId: string;
  serial: string;
  privateKey: string;
  publicKeys: Record<string, string>;
  apiKey: string;
  publicUrl: string;
  baseURL?: string;
}
export class WechatGateway implements PaymentGateway {
  provider = "wechatpay" as const;
  merchantId: string;
  private client: Wechatpay;
  constructor(private options: WechatOptions) {
    this.merchantId = options.merchantId;
    if (
      Buffer.byteLength(options.apiKey) !== 32 ||
      !Object.keys(options.publicKeys).length
    )
      throw new Error("WECHAT_KEYS_INVALID");
    this.client = new Wechatpay({
      mchid: options.merchantId,
      serial: options.serial,
      privateKey: options.privateKey,
      certs: Object.fromEntries(
        Object.entries(options.publicKeys).map(([id, pem]) => [
          id,
          createPublicKey(pem),
        ]),
      ),
      timeout: 10_000,
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
      baseURL: options.baseURL ?? "https://api.mch.weixin.qq.com/",
    });
  }
  private async request(method: string, path: string, data?: unknown) {
    try {
      return (await this.client.client.request(path, method, data))
        .data as unknown;
    } catch (error) {
      const e = error as {
        response?: { status?: number; data?: { code?: string } };
      };
      if (
        ["ORDER_NOT_EXIST", "RESOURCE_NOT_EXISTS"].includes(
          e.response?.data?.code ?? "",
        )
      )
        throw new GatewayError("TRADE_NOT_FOUND");
      if (["ORDERPAID", "ORDER_CLOSED"].includes(e.response?.data?.code ?? ""))
        throw new GatewayError("PAYMENT_RESULT_REQUIRES_QUERY", true);
      throw new GatewayError(
        "WECHAT_REQUEST_FAILED",
        ![400, 401, 403, 404, 422].includes(e.response?.status ?? 0),
      );
    }
  }
  async create(
    payment: Payment,
    input: { description: string; expiresAt: string; ip: string },
  ) {
    const h5 = payment.channel === "wechat_h5";
    const startedAt = Date.now();
    const response = await this.request(
      "POST",
      `/v3/pay/transactions/${h5 ? "h5" : "native"}`,
      {
        appid: this.options.appId,
        mchid: this.merchantId,
        description: input.description.slice(0, 100),
        out_trade_no: payment.id,
        time_expire: input.expiresAt,
        notify_url: `${this.options.publicUrl}/api/webhooks/wechatpay`,
        amount: { total: payment.amount, currency: "CNY" },
        ...(h5
          ? {
              scene_info: {
                payer_client_ip: input.ip,
                h5_info: { type: "Wap" },
              },
            }
          : {}),
      },
    );
    const value = z
      .object({
        code_url: z.string().optional(),
        h5_url: z.string().url().optional(),
      })
      .parse(response);
    const link = h5 ? value.h5_url : value.code_url;
    if (
      !link ||
      (h5
        ? new URL(link).origin !== "https://wx.tenpay.com"
        : !link.startsWith("weixin://wxpay/"))
    )
      throw new GatewayError("WECHAT_CHECKOUT_INVALID", true);
    return {
      kind: h5 ? ("redirect" as const) : ("qr" as const),
      value: link,
      ...(h5
        ? {
            expiresAt: new Date(
              Math.min(startedAt + 5 * 60_000, Date.parse(input.expiresAt)),
            ).toISOString(),
          }
        : {}),
    };
  }
  private payment(value: unknown): PaymentResult {
    const body = z
      .object({
        out_trade_no: z.string(),
        mchid: z.string(),
        appid: z.string(),
        trade_state: z.enum([
          "SUCCESS",
          "REFUND",
          "NOTPAY",
          "CLOSED",
          "REVOKED",
          "USERPAYING",
          "PAYERROR",
        ]),
        transaction_id: z.string().optional(),
        success_time: z.string().optional(),
        amount: z.object({ total: money, currency: z.literal("CNY") }),
      })
      .parse(value);
    if (body.mchid !== this.merchantId || body.appid !== this.options.appId)
      throw new GatewayError("MERCHANT_MISMATCH");
    return {
      merchantOrderNo: body.out_trade_no,
      merchantId: body.mchid,
      amount: body.amount.total,
      currency: "CNY",
      providerTransactionId: body.transaction_id,
      succeededAt: ["SUCCESS", "REFUND"].includes(body.trade_state)
        ? successTime(body.success_time)
        : undefined,
      status: ["SUCCESS", "REFUND"].includes(body.trade_state)
        ? "succeeded"
        : ["CLOSED", "REVOKED"].includes(body.trade_state)
          ? "closed"
          : body.trade_state === "PAYERROR"
            ? "failed"
            : "pending",
    };
  }
  async query(payment: Payment) {
    try {
      return this.payment(
        await this.request(
          "GET",
          `/v3/pay/transactions/out-trade-no/${payment.id}?mchid=${this.merchantId}`,
        ),
      );
    } catch (error) {
      if (error instanceof GatewayError && error.code === "TRADE_NOT_FOUND")
        return null;
      throw error;
    }
  }
  async close(payment: Payment) {
    await this.request(
      "POST",
      `/v3/pay/transactions/out-trade-no/${payment.id}/close`,
      { mchid: this.merchantId },
    );
  }
  private refundResult(value: unknown): RefundResult {
    const body = z
      .object({
        out_refund_no: z.string(),
        out_trade_no: z.string(),
        refund_id: z.string(),
        status: z.enum(["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"]),
        success_time: z.string().optional(),
        amount: z.object({ refund: money, currency: z.literal("CNY") }),
      })
      .parse(value);
    return {
      merchantRefundNo: body.out_refund_no,
      merchantOrderNo: body.out_trade_no,
      amount: body.amount.refund,
      providerRefundId: body.refund_id,
      succeededAt:
        body.status === "SUCCESS" ? successTime(body.success_time) : undefined,
      status:
        body.status === "SUCCESS"
          ? "succeeded"
          : body.status === "PROCESSING"
            ? "processing"
            : body.status === "ABNORMAL"
              ? "abnormal"
              : "failed",
    };
  }
  async refund(refund: Refund, payment: Payment) {
    return this.refundResult(
      await this.request("POST", "/v3/refund/domestic/refunds", {
        out_trade_no: payment.id,
        out_refund_no: refund.id,
        reason: "商城售后退款",
        notify_url: `${this.options.publicUrl}/api/webhooks/wechatpay`,
        amount: {
          refund: refund.amount,
          total: payment.amount,
          currency: "CNY",
        },
      }),
    );
  }
  async queryRefund(refund: Refund) {
    try {
      return this.refundResult(
        await this.request("GET", `/v3/refund/domestic/refunds/${refund.id}`),
      );
    } catch (error) {
      if (error instanceof GatewayError && error.code === "TRADE_NOT_FOUND")
        return null;
      throw error;
    }
  }
  webhook(raw: Buffer, headers: IncomingHttpHeaders): GatewayEvent {
    const serial = String(headers["wechatpay-serial"] ?? ""),
      timestamp = String(headers["wechatpay-timestamp"] ?? ""),
      nonce = String(headers["wechatpay-nonce"] ?? ""),
      signature = String(headers["wechatpay-signature"] ?? "");
    const pem = this.options.publicKeys[serial];
    if (
      !pem ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !nonce ||
      signature.startsWith("WECHATPAY/SIGNTEST/") ||
      !verify(
        "RSA-SHA256",
        Buffer.concat([
          Buffer.from(`${timestamp}\n${nonce}\n`),
          raw,
          Buffer.from("\n"),
        ]),
        pem,
        Buffer.from(signature, "base64"),
      )
    )
      throw new GatewayError("WEBHOOK_SIGNATURE_INVALID");
    const body = z
      .object({
        id: z.string().max(128),
        event_type: z.string(),
        resource: z.object({
          algorithm: z.literal("AEAD_AES_256_GCM"),
          ciphertext: z.string(),
          nonce: z.string(),
          associated_data: z.string().optional(),
        }),
      })
      .parse(JSON.parse(raw.toString("utf8")));
    const value = JSON.parse(
      Aes.AesGcm.decrypt(
        body.resource.ciphertext,
        this.options.apiKey,
        body.resource.nonce,
        body.resource.associated_data ?? "",
      ),
    );
    if (body.event_type === "TRANSACTION.SUCCESS")
      return {
        id: body.id,
        kind: "payment",
        result: this.payment({ ...value, trade_state: "SUCCESS" }),
      };
    if (
      !["REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"].includes(
        body.event_type,
      ) ||
      value.mchid !== this.merchantId
    )
      throw new GatewayError("WEBHOOK_EVENT_INVALID");
    // Domestic refund callbacks omit currency; CNY is fixed by this API product.
    if (value.amount?.currency !== undefined && value.amount.currency !== "CNY")
      throw new GatewayError("REFUND_CURRENCY_INVALID");
    return {
      id: body.id,
      kind: "refund",
      result: this.refundResult({
        ...value,
        status: value.refund_status,
        amount: { ...value.amount, currency: "CNY" },
      }),
    };
  }
  async bill(date: string) {
    const metadata = z
      .object({
        download_url: z.string().url(),
        hash_type: z.string(),
        hash_value: z.string(),
      })
      .parse(
        await this.request(
          "GET",
          `/v3/bill/tradebill?bill_date=${date}&bill_type=ALL`,
        ),
      );
    const target = new URL(metadata.download_url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      !["api.mch.weixin.qq.com", "api2.mch.weixin.qq.com"].includes(
        target.hostname,
      ) ||
      target.pathname !== "/v3/billdownload/file"
    )
      throw new GatewayError("BILL_URL_INVALID");
    // Bill downloads require the same signed Authorization as other APIv3 requests.
    const response = await this.client.client.request(
      target.pathname,
      "GET",
      undefined,
      {
        baseURL: this.options.baseURL ?? target.origin,
        params: target.searchParams,
        responseType: "arraybuffer",
        timeout: 20_000,
        maxContentLength: 20 * 1024 * 1024,
        maxRedirects: 0,
      },
    );
    const bytes = Buffer.from(response.data);
    if (
      !["SHA1", "SHA256"].includes(metadata.hash_type) ||
      createHash(metadata.hash_type.toLowerCase())
        .update(bytes)
        .digest("hex") !== metadata.hash_value
    )
      throw new GatewayError("BILL_DIGEST_INVALID");
    return parseBill(bytes.toString("utf8"), this.provider);
  }
}

export interface AlipayOptions {
  appId: string;
  merchantId: string;
  privateKey: string;
  publicKey?: string;
  publicUrl: string;
  gateway?: string;
  appCertPath?: string;
  alipayPublicCertPath?: string;
  alipayRootCertPath?: string;
}
export class AlipayGateway implements PaymentGateway {
  provider = "alipay" as const;
  merchantId: string;
  private client: AlipaySdk;
  constructor(private options: AlipayOptions) {
    this.merchantId = options.merchantId;
    if (!options.publicKey && !options.alipayPublicCertPath)
      throw new Error("ALIPAY_VERIFICATION_KEY_REQUIRED");
    this.client = new AlipaySdk({
      appId: options.appId,
      privateKey: options.privateKey,
      alipayPublicKey: options.publicKey,
      keyType: "PKCS8",
      signType: "RSA2",
      camelcase: false,
      timeout: 10_000,
      gateway: options.gateway ?? "https://openapi.alipay.com/gateway.do",
      appCertPath: options.appCertPath,
      alipayPublicCertPath: options.alipayPublicCertPath,
      alipayRootCertPath: options.alipayRootCertPath,
    });
  }
  private async exec(method: string, bizContent: Record<string, unknown>) {
    try {
      const body = await this.client.exec(
        method,
        { bizContent },
        { validateSign: true },
      );
      if (body.code !== "10000") {
        if (body.sub_code === "ACQ.TRADE_NOT_EXIST")
          throw new GatewayError("TRADE_NOT_FOUND");
        throw new GatewayError("ALIPAY_REJECTED", body.code === "20000");
      }
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("ALIPAY_REQUEST_FAILED", true);
    }
  }
  async create(
    payment: Payment,
    input: { description: string; expiresAt: string },
  ) {
    const wap = payment.channel === "alipay_wap";
    const value = this.client.pageExecute(
      wap ? "alipay.trade.wap.pay" : "alipay.trade.page.pay",
      "GET",
      {
        notifyUrl: `${this.options.publicUrl}/api/webhooks/alipay`,
        returnUrl: `${this.options.publicUrl}/orders/${payment.orderId}/pay`,
        bizContent: {
          out_trade_no: payment.id,
          seller_id: this.merchantId,
          total_amount: decimal(payment.amount),
          subject: input.description.slice(0, 100),
          product_code: wap ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY",
          time_expire: new Date(input.expiresAt).toLocaleString("sv-SE", {
            timeZone: "Asia/Shanghai",
          }),
        },
      },
    );
    return { kind: "redirect" as const, value };
  }
  private payment(value: unknown): PaymentResult {
    const body = z
      .object({
        out_trade_no: z.string(),
        total_amount: z.string(),
        trade_status: z.enum([
          "WAIT_BUYER_PAY",
          "TRADE_CLOSED",
          "TRADE_SUCCESS",
          "TRADE_FINISHED",
        ]),
        trade_no: z.string().optional(),
        seller_id: z.string().optional(),
        seller_user_id: z.string().optional(),
        send_pay_date: z.string().optional(),
        gmt_payment: z.string().optional(),
      })
      .parse(value);
    const merchant = body.seller_id ?? body.seller_user_id;
    if (merchant && merchant !== this.merchantId)
      throw new GatewayError("MERCHANT_MISMATCH");
    return {
      merchantOrderNo: body.out_trade_no,
      merchantId: this.merchantId,
      amount: cents(body.total_amount),
      currency: "CNY",
      providerTransactionId: body.trade_no,
      succeededAt: ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(
        body.trade_status,
      )
        ? successTime(body.send_pay_date ?? body.gmt_payment, true)
        : undefined,
      status: ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(body.trade_status)
        ? "succeeded"
        : body.trade_status === "TRADE_CLOSED"
          ? "closed"
          : "pending",
    };
  }
  async query(payment: Payment) {
    try {
      return this.payment(
        await this.exec("alipay.trade.query", { out_trade_no: payment.id }),
      );
    } catch (error) {
      if (error instanceof GatewayError && error.code === "TRADE_NOT_FOUND")
        return null;
      throw error;
    }
  }
  async close(payment: Payment) {
    await this.exec("alipay.trade.close", { out_trade_no: payment.id });
  }
  async refund(refund: Refund, payment: Payment) {
    const result = await this.exec("alipay.trade.refund", {
      out_trade_no: payment.id,
      out_request_no: refund.id,
      refund_amount: decimal(refund.amount),
      refund_reason: "商城售后退款",
    });
    if (cents(z.string().parse(result.refund_fee)) !== refund.amount)
      throw new GatewayError("REFUND_AMOUNT_MISMATCH", true);
    return {
      merchantRefundNo: refund.id,
      merchantOrderNo: payment.id,
      amount: refund.amount,
      status: "succeeded" as const,
      providerRefundId: z.string().parse(result.trade_no),
      succeededAt: successTime(result.gmt_refund_pay, true),
    };
  }
  async queryRefund(refund: Refund, payment: Payment) {
    try {
      const body = await this.exec("alipay.trade.fastpay.refund.query", {
        out_trade_no: payment.id,
        out_request_no: refund.id,
        query_options: ["gmt_refund_pay"],
      });
      if (!body.refund_status)
        throw new GatewayError("REFUND_RESULT_UNKNOWN", true);
      const status =
        body.refund_status === "REFUND_SUCCESS"
          ? ("succeeded" as const)
          : ("processing" as const);
      return {
        merchantRefundNo: z.string().parse(body.out_request_no),
        merchantOrderNo: z.string().parse(body.out_trade_no),
        amount: cents(z.string().parse(body.refund_amount)),
        status,
        providerRefundId: z.string().parse(body.trade_no),
        succeededAt:
          status === "succeeded"
            ? successTime(body.gmt_refund_pay, true)
            : undefined,
      };
    } catch (error) {
      if (error instanceof GatewayError && error.code === "TRADE_NOT_FOUND")
        return null;
      throw error;
    }
  }
  webhook(raw: Buffer): GatewayEvent {
    const params = new URLSearchParams(raw.toString("utf8"));
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length)
      throw new GatewayError("WEBHOOK_DUPLICATE_FIELDS");
    const data = Object.fromEntries(params);
    if (
      data.app_id !== this.options.appId ||
      data.seller_id !== this.merchantId ||
      data.sign_type !== "RSA2" ||
      !this.client.checkNotifySignV2(data)
    )
      throw new GatewayError("WEBHOOK_SIGNATURE_INVALID");
    const result = this.payment(data);
    if (result.status !== "succeeded")
      throw new GatewayError("WEBHOOK_EVENT_INVALID");
    return {
      id: z.string().max(128).parse(data.notify_id),
      kind: "payment",
      result,
    };
  }
  async bill(date: string) {
    const body = await this.exec(
      "alipay.data.dataservice.bill.downloadurl.query",
      { bill_type: "trade", bill_date: date },
    );
    const bytes = await download(
      z.string().parse(body.bill_download_url),
      /^(?:[a-z0-9-]+\.)*(?:alipay\.com|alipayobjects\.com)$/,
    );
    const entries: BillEntry[] = [];
    let expanded = 0;
    // Inspect the ZIP directory before decompression; compressed size alone does not bound expansion.
    const archive = unzipSync(bytes, {
      filter: (entry) => {
        expanded += entry.originalSize;
        if (expanded > 100 * 1024 * 1024)
          throw new GatewayError("BILL_TOO_LARGE");
        return entry.name.endsWith(".csv") && !entry.name.includes("汇总");
      },
    });
    for (const content of Object.values(archive))
      entries.push(
        ...parseBill(
          new TextDecoder("gb18030", { fatal: true }).decode(content),
          this.provider,
        ),
      );
    if (!Object.keys(archive).length)
      throw new GatewayError("BILL_FORMAT_INVALID");
    return entries;
  }
}

export function configuredGateways(
  channels: PaymentChannel[],
  publicUrl: string,
): Partial<Record<PaymentProvider, PaymentGateway>> {
  const gateways: Partial<Record<PaymentProvider, PaymentGateway>> = {};
  if (channels.some((channel) => channel.startsWith("wechat_"))) {
    const keyId = required("WECHAT_PUBLIC_KEY_ID");
    gateways.wechatpay = new WechatGateway({
      appId: required("WECHAT_APP_ID"),
      merchantId: required("WECHAT_MCH_ID"),
      serial: required("WECHAT_MERCHANT_SERIAL"),
      privateKey: keyFile("WECHAT_PRIVATE_KEY_FILE"),
      publicKeys: { [keyId]: keyFile("WECHAT_PUBLIC_KEY_FILE") },
      apiKey: required("WECHAT_API_V3_KEY"),
      publicUrl,
    });
  }
  if (channels.some((channel) => channel.startsWith("alipay_"))) {
    const gateway =
      process.env.ALIPAY_GATEWAY ?? "https://openapi.alipay.com/gateway.do";
    if (
      ![
        "https://openapi.alipay.com/gateway.do",
        "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
      ].includes(gateway)
    )
      throw new Error("ALIPAY_GATEWAY_INVALID");
    gateways.alipay = new AlipayGateway({
      appId: required("ALIPAY_APP_ID"),
      merchantId: required("ALIPAY_SELLER_ID"),
      privateKey: keyFile("ALIPAY_PRIVATE_KEY_FILE"),
      publicKey: process.env.ALIPAY_PUBLIC_KEY_FILE
        ? keyFile("ALIPAY_PUBLIC_KEY_FILE")
        : undefined,
      publicUrl,
      gateway,
      appCertPath: process.env.ALIPAY_APP_CERT_FILE,
      alipayPublicCertPath: process.env.ALIPAY_PUBLIC_CERT_FILE,
      alipayRootCertPath: process.env.ALIPAY_ROOT_CERT_FILE,
    });
  }
  return gateways;
}
