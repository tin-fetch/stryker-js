export interface Address {
  street: string;
  city: string;
}

export interface Order {
  id: string;
  shippingAddress: Address;
  billingAddress: Address;
  items: string[];
  note: string | undefined;
}

export function formatAddress(address: Address): string {
  return `${address.street}, ${address.city}`;
}

export function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) {
    result.push(i);
  }
  return result;
}

export function shippingLabel(order: Order): string {
  return `${order.id}: ${formatAddress(order.shippingAddress)}`;
}

export function pageNumbers(order: Order): number[] {
  return range(1, order.items.length);
}

export async function loadOrder(
  fetchOrder: (id: string) => Promise<Order>,
  id: string,
): Promise<Order> {
  return await fetchOrder(id);
}

export type OrderStatus = 'open' | 'shipped' | 'cancelled';

export interface Shipment {
  from: Address;
  to: Address;
}

export function createShipment(order: Order): Shipment {
  return { from: order.billingAddress, to: order.shippingAddress };
}

export class OrderTracker {
  status: OrderStatus = 'open';
  shippedAt: Date | undefined;
  cancelledAt: Date | undefined;

  ship(at: Date): void {
    this.status = 'shipped';
    this.shippedAt = at;
  }
}
