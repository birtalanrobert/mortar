/**
 * The billing address a buyer gave cannot be placed for its tax — a country
 * missing, a postal code the provider does not know — so nothing was charged.
 * The buyer is asked to check it; it is not the product's fault, nor the
 * provider's.
 */
export class PaymentLocationError extends Error {
  readonly code = 'payment_location_invalid';

  constructor(message = 'The billing address cannot be placed for its tax.') {
    super(message);
    this.name = 'PaymentLocationError';
  }
}
