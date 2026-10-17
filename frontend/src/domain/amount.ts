export function yuanToCents(value: string, minimum = 1): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error("金额请以元填写，最多两位小数");
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents < BigInt(minimum) || cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`金额超出范围，至少 ${centsToYuan(minimum)} 元`);
  return Number(cents);
}
export function centsToYuan(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
