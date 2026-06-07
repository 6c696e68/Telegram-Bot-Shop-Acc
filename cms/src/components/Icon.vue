<script setup lang="ts">
/**
 * Icon — wrapper quanh bộ icon Lucide (@lucide/vue).
 * Giữ nguyên API cũ `<Icon name="..." :size="..." />` để không phải sửa các view.
 * Mọi icon dùng currentColor + nét mảnh đồng nhất.
 */
import { computed } from 'vue'
import {
  LayoutGrid,
  Users,
  User,
  FolderTree,
  Package,
  ShoppingCart,
  Receipt,
  Wallet,
  Settings,
  Store,
  Search,
  Download,
  Upload,
  RefreshCw,
  Trash2,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Image as ImageIcon,
  X,
  TrendingUp,
  Coins,
  Landmark,
  Lock,
  LogOut,
  Menu,
  TriangleAlert,
  Check,
  Plus,
  Pencil,
  Code,
  Link,
  Copy,
  KeyRound,
  Eye,
  EyeOff,
  type LucideIcon,
} from '@lucide/vue'

const props = withDefaults(defineProps<{ name: string; size?: number | string }>(), {
  size: 20,
})

// Map tên icon (giữ tương thích với cách gọi cũ) → component Lucide.
const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutGrid,
  users: Users,
  user: User,
  category: FolderTree,
  product: Package,
  package: Package,
  cart: ShoppingCart,
  receipt: Receipt,
  wallet: Wallet,
  settings: Settings,
  store: Store,
  search: Search,
  download: Download,
  upload: Upload,
  refresh: RefreshCw,
  trash: Trash2,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  chevronRight: ChevronRight,
  image: ImageIcon,
  close: X,
  trend: TrendingUp,
  coins: Coins,
  bank: Landmark,
  lock: Lock,
  logout: LogOut,
  menu: Menu,
  warning: TriangleAlert,
  check: Check,
  plus: Plus,
  edit: Pencil,
  code: Code,
  link: Link,
  copy: Copy,
  key: KeyRound,
  eye: Eye,
  eyeOff: EyeOff,
}

const component = computed(() => ICONS[props.name] ?? null)
const sizeValue = computed(() => Number(props.size))
</script>

<template>
  <component
    :is="component"
    v-if="component"
    :size="sizeValue"
    :stroke-width="2"
    aria-hidden="true"
  />
</template>
