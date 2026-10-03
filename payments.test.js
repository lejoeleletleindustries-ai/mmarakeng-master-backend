const assert = require("assert");
const { MpesaProvider } = require("../src/payments/MpesaProvider");
const { EcocashProvider } = require("../src/payments/EcocashProvider");
const PaymentService = require("../src/payments/PaymentService");

function test(name, fn) {
  try {
    fn();
    console.log("PASS:", name);
  } catch (e) {
    console.error("FAIL:", name, e.message);
    process.exitCode = 1;
  }
}

test("MpesaProvider defaults disabled", () => {
  const m = new MpesaProvider();
  assert.strictEqual(m.enabled, false);
  assert.strictEqual(m.isConfigured(), false);
  const s = m.configStatus();
  assert.strictEqual(s.credentials_configured, false);
  assert.ok(!("clientSecret" in s));
});

test("EcocashProvider defaults disabled", () => {
  const e = new EcocashProvider();
  assert.strictEqual(e.enabled, false);
  assert.strictEqual(e.isConfigured(), false);
});

test("providersStatus never leaks secrets", () => {
  const s = PaymentService.providersStatus();
  const json = JSON.stringify(s);
  assert.ok(!json.includes("SECRET"));
  assert.ok(s.mpesa);
  assert.ok(s.ecocash);
  assert.strictEqual(s.currency, process.env.CURRENCY || "LSL");
});

test("PaymentStatus constants", () => {
  assert.strictEqual(PaymentService.PaymentStatus.SUCCESSFUL, "successful");
  assert.strictEqual(PaymentService.PaymentStatus.PENDING, "pending");
});

console.log("Payment unit tests finished.");
