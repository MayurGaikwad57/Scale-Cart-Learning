// Types mirroring the backend API responses. Money is always integer cents.

export type Role = 'CUSTOMER' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  role: Role;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  active: boolean;
  createdAt: string;
  stock: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ProductSort = 'newest' | 'price_asc' | 'price_desc' | 'name';

export interface ProductQuery {
  page: number;
  pageSize: number;
  q?: string;
  category?: string;
  minPrice?: number; // cents
  maxPrice?: number; // cents
  sort: ProductSort;
  includeInactive?: boolean;
}

export interface CartItem {
  id: string;
  productId: string;
  name: string;
  sku: string;
  category: string;
  priceCents: number;
  quantity: number;
  lineTotalCents: number;
  stock: number;
  purchasable: boolean;
}

export interface Cart {
  id: string;
  items: CartItem[];
  itemCount: number;
  totalCents: number;
}

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type PaymentMethod = 'TEST_CARD_SUCCESS' | 'TEST_CARD_DECLINE';

export interface OrderItem {
  productId: string;
  name: string;
  sku: string;
  category: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  /** Why a CANCELLED order was cancelled: payment_declined | inventory_unavailable | out_of_stock | reservation_released */
  statusReason: string | null;
  totalCents: number;
  createdAt: string;
  items: OrderItem[];
  payment: { status: PaymentStatus; amountCents: number } | null;
}

export interface AuthResponse {
  user: User;
  token: string;
}

/** GET /admin/system - a look at ScaleKV (our own Redis-like store) and the M4 settings. */
export type KvStatus = 'disabled' | 'connecting' | 'ready' | 'down';
export interface SystemStatus {
  kv: {
    status: KvStatus;
    url: string | null;
    stats: {
      uptimeSeconds: number;
      connectedClients: number;
      keys: number;
      keysWithTtl: number;
      maxKeys: number;
      commandsProcessed: number;
      hits: number;
      misses: number;
      hitRatePercent: number;
      expiredKeys: number;
      evictedKeys: number;
      memoryBytes: number;
    } | null;
  };
  cache: { hits: number; misses: number; bypass: number; hitRatePercent: number; productTtlSeconds: number; listTtlSeconds: number; categoriesTtlSeconds: number; notFoundTtlSeconds: number };
  rateLimits: { name: string; limit: number; window: string; per: string; appliesTo: string }[];
}

/** M5: written asynchronously by the "notification" consumer group. */
export interface AppNotification {
  id: string;
  orderId: string | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

/** GET /admin/events - a look inside ScaleLog (our own Kafka). */
export interface EventsOverview {
  broker: { status: KvStatus; url: string | null };
  cluster: {
    topics: { name: string; partitions: { partition: number; endOffset: number }[] }[];
    groups: {
      group: string;
      topic: string;
      generation: number;
      members: { id: string; partitions: number[]; lastSeenMsAgo: number }[];
      partitions: { partition: number; committed: number; endOffset: number; lag: number }[];
    }[];
    stats: { produced: number; fetchedRecords: number; commits: number; rebalances: number };
  } | null;
  publisher: { published: number; notPublished: number; lastError: string | null };
  localConsumers: { group: string; memberId: string; generation: number; partitions: number[]; processed: number; retries: number; deadLettered: number; rebalances: number; lastError: string | null }[];
  chaos: Record<string, boolean>;
  chaosAvailable: boolean;
}

export interface DlqView {
  topic: string;
  total: number;
  // eventId/type/orderId are missing for an unreadable or malformed record - exactly what DLQs collect.
  waiting: { offset: number; eventId?: string; type?: string; orderId?: string; error: string; attempts: number; failedAt: string }[];
}

export interface Projections {
  sales: { day: string; confirmedOrders: number; cancelledOrders: number; revenueCents: number }[];
  stockAlerts: { productId: string; name: string; sku: string; available: number; updatedAt: string }[];
}

// ---- M6: Admin > Services (served by the API gateway and the payment service)
export interface ServiceConsumer {
  group: string;
  topic: string;
  memberId: string;
  generation: number;
  partitions: number[];
  processed: number;
  retries: number;
  deadLettered: number;
}

export interface ServiceStatus {
  service: 'identity' | 'catalog' | 'order' | 'payment' | 'inventory' | 'notification';
  url: string;
  up: boolean;
  latencyMs: number;
  status: string;
  pid?: number;
  uptimeSeconds?: number;
  kv?: KvStatus;
  log?: KvStatus;
  consumers?: ServiceConsumer[];
  routes: string[];
  groups: { group: string; topic: string; description: string }[];
  traffic: { requests: number; errors: number; unavailable: number; inFlight: number; avgMs: number; lastError: string | null };
}

export interface ServicesOverview {
  gateway: { pid: number; uptimeSeconds: number; kv: KvStatus };
  services: ServiceStatus[];
}

export interface PaymentsOverview {
  providerDelayMs: number;
  totals: { status: PaymentStatus; count: number; amountCents: number }[];
  recent: { id: string; orderId: string; amountCents: number; status: PaymentStatus; method: string | null; providerRef: string | null; createdAt: string }[];
}
