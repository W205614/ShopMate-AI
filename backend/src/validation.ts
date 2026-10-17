import { z } from "zod";
import {
  imageBytes,
  validateImages,
  IMAGE_MAX_ENCODED_LENGTH,
} from "../../shared/domain/images";
const image = z
  .string()
  .max(IMAGE_MAX_ENCODED_LENGTH)
  .superRefine((value, ctx) => {
    try {
      imageBytes(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
export const roleSchema = z.enum(["user", "admin"]);
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "账号长度须为 3–32 位")
  .max(32, "账号长度须为 3–32 位")
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    "账号须以字母开头，仅含字母、数字或下划线，长度 3–32 位",
  )
  .transform((s) => s.toLowerCase());
export const passwordSchema = z
  .string()
  .min(10, "密码长度须为 10–128 位")
  .max(128, "密码长度须为 10–128 位")
  .regex(/[a-zA-Z]/, "密码须包含字母")
  .regex(/[0-9]/, "密码须包含数字");
export const registerSchema = z
  .object({
    username: usernameSchema,
    name: z.string().trim().min(1, "请输入昵称").max(30, "昵称不能超过 30 字"),
    password: passwordSchema,
  })
  .strict();
export const loginSchema = z
  .object({
    role: roleSchema,
    username: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .transform((s) => s.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();
const id = z.string().min(1).max(100);
const text = (max: number) => z.string().trim().min(1).max(max);
const settings = z
  .object({
    name: text(40),
    slogan: text(80),
    notice: z.string().trim().max(200),
  })
  .strict();
const integer = z.number().int().safe();
const address = z
  .object({
    id: id.optional(),
    name: text(50),
    phone: text(20),
    region: text(100),
    detail: text(200),
    isDefault: z.boolean(),
  })
  .strict();
const category = z
  .object({
    id: id.optional(),
    name: text(30),
    description: text(200),
    image,
    sort: integer.nonnegative(),
  })
  .strict();
const product = z
  .object({
    id: id.optional(),
    name: text(80),
    subtitle: text(120),
    description: text(3000),
    material: text(300),
    categoryId: id,
    images: z
      .array(z.string().max(IMAGE_MAX_ENCODED_LENGTH))
      .min(1)
      .max(12)
      .superRefine((values, ctx) => {
        try {
          validateImages(values);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
        }
      }),
    skus: z
      .array(
        z
          .object({
            id: z.string().max(100),
            name: text(100),
            price: integer.positive(),
            stock: integer.nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    active: z.boolean(),
    featured: z.boolean(),
  })
  .strict();
export const methods = {
  batchCart: {
    role: "user",
    args: z.tuple([
      z
        .object({
          ids: z.array(id).min(1).max(500),
          action: z.enum(["select", "remove"]),
          selected: z.boolean().optional(),
        })
        .strict(),
    ]),
  },
  clearInvalidCart: { role: "user", args: z.tuple([]) },
  retireCheckout: {
    role: "user",
    args: z.tuple([z.object({ quoteId: id, requestId: id }).strict()]),
  },
  quoteCheckout: {
    role: "user",
    args: z.tuple([
      z
        .object({
          source: z.discriminatedUnion("type", [
            z
              .object({
                type: z.literal("cart"),
                cartIds: z.array(id).min(1).max(500),
              })
              .strict(),
            z
              .object({
                type: z.literal("buyNow"),
                productId: id,
                skuId: id,
                quantity: integer.positive(),
              })
              .strict(),
          ]),
          addressId: id,
          couponClaimId: id.optional(),
        })
        .strict(),
    ]),
  },
  reorder: { role: "user", args: z.tuple([id]) },
  saveCoupon: {
    role: "admin",
    args: z.tuple([
      z
        .object({
          id: id.optional(),
          name: text(60),
          threshold: integer.positive(),
          discount: integer.positive(),
          claimStartsAt: z.string().datetime({ offset: true }),
          claimEndsAt: z.string().datetime({ offset: true }),
          validFrom: z.string().datetime({ offset: true }),
          validUntil: z.string().datetime({ offset: true }),
          totalLimit: integer.positive(),
          active: z.boolean(),
        })
        .strict(),
    ]),
  },
  claimCoupon: { role: "user", args: z.tuple([id]) },
  toggleCoupon: { role: "admin", args: z.tuple([id]) },
  submitReview: {
    role: "user",
    args: z.tuple([
      z
        .object({
          orderId: id,
          orderItemId: id,
          rating: integer.min(1).max(5),
          content: text(1000).min(5),
        })
        .strict(),
    ]),
  },
  deleteReview: { role: "user", args: z.tuple([id]) },
  moderateReview: { role: "admin", args: z.tuple([id, z.boolean()]) },
  cancelAfterSale: { role: "user", args: z.tuple([id]) },
  submitReturn: { role: "user", args: z.tuple([id, text(60), text(80)]) },
  addCart: { role: "user", args: z.tuple([id, id, integer.positive()]) },
  updateCart: {
    role: "user",
    args: z.tuple([
      id,
      z
        .object({
          quantity: integer.positive().optional(),
          selected: z.boolean().optional(),
        })
        .strict(),
    ]),
  },
  removeCart: { role: "user", args: z.tuple([id]) },
  favorite: { role: "user", args: z.tuple([id]) },
  saveAddress: { role: "user", args: z.tuple([address]) },
  deleteAddress: { role: "user", args: z.tuple([id]) },
  createOrder: {
    role: "user",
    args: z.tuple([z.object({ quoteId: id, requestId: id }).strict()]),
  },
  payOrder: { role: "user", args: z.tuple([id]) },
  cancelOrder: { role: "user", args: z.tuple([id]) },
  confirmOrder: { role: "user", args: z.tuple([id]) },
  requestAfterSale: {
    role: "user",
    args: z.tuple([
      id,
      text(100),
      text(1000),
      z
        .array(
          z.object({ orderItemId: id, quantity: integer.positive() }).strict(),
        )
        .min(1)
        .max(500),
    ]),
  },
  createConversation: {
    role: "user",
    args: z.tuple([
      z
        .object({ productId: id.optional(), orderId: id.optional() })
        .strict()
        .optional(),
    ]),
  },
  sendMessage: { role: "user", args: z.tuple([id, text(1000)]) },
  transferConversation: { role: "user", args: z.tuple([id]) },
  saveProduct: { role: "admin", args: z.tuple([product]) },
  toggleProduct: { role: "admin", args: z.tuple([id]) },
  saveCategory: { role: "admin", args: z.tuple([category]) },
  deleteCategory: { role: "admin", args: z.tuple([id]) },
  adjustStock: {
    role: "admin",
    args: z.tuple([
      id,
      id,
      integer,
      integer.nonnegative(),
      text(200),
      z
        .object({
          requestId: id,
          mode: z.enum(["delta", "count"]).optional(),
          expectedStock: integer.nonnegative().optional(),
        })
        .strict()
        .optional(),
    ]),
  },
  shipOrder: { role: "admin", args: z.tuple([id, text(60), text(80)]) },
  processAfterSale: {
    role: "admin",
    args: z.tuple([
      id,
      z.enum(["approve", "reject", "receive", "refund"]),
      z.string().max(500).optional(),
    ]),
  },
  replyConversation: { role: "admin", args: z.tuple([id, text(1000)]) },
  closeConversation: { role: "admin", args: z.tuple([id]) },
  saveFaq: {
    role: "admin",
    args: z.tuple([
      z
        .object({
          id: id.optional(),
          question: text(100),
          answer: text(2000),
          keywords: z.array(text(60)).min(1).max(50),
          active: z.boolean(),
        })
        .strict(),
    ]),
  },
  deleteFaq: { role: "admin", args: z.tuple([id]) },
  saveSettings: {
    role: "admin",
    args: z.tuple([settings, settings]),
  },
  resetDemo: { role: "admin", args: z.tuple([]) },
} as const;
