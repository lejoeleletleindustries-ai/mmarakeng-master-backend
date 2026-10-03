/** Canonical payment statuses used by all providers */
const PaymentStatus = {
  PENDING: "pending",
  INITIATED: "initiated",
  SUCCESSFUL: "successful",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired"
};

/**
 * @typedef {Object} PaymentCreateInput
 * @property {string} userId
 * @property {number} amount
 * @property {string} currency
 * @property {string} purpose
 * @property {string} [listingId]
 * @property {string} [productId]
 * @property {string} [planId]
 * @property {string} [orderId]
 * @property {string} [sellerId]
 * @property {string} [customerPhone]
 * @property {string} [idempotencyKey]
 * @property {object} [metadata]
 */

module.exports = { PaymentStatus };
