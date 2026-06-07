<script setup lang="ts">
/**
 * OrderCard — thẻ một đơn hàng trong danh sách (Obsidian Glass, Req 11.1/11.2).
 *  - Header: #mã đơn + ngày + chip trạng thái (completed/refunded).
 *  - Thân: ô màu + glyph + tên + (số lượng · tổng tiền).
 *  - Footer: "Hỗ trợ" (emit support) + "Chi tiết" (emit detail → xem nội dung tài khoản).
 *  Danh sách `/orders` không trả `contents`; nội dung đăng nhập xem ở màn chi tiết.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { LifeBuoy, ChevronRight, CircleCheck, Undo2 } from '@lucide/vue'
import { avatarColor } from '@/utils/avatar'
import type { OrderListItemDto } from '@/types'

const props = defineProps<{ order: OrderListItemDto }>()
defineEmits<{ (e: 'detail'): void; (e: 'support'): void }>()

const { t } = useI18n()

const tileColor = computed(() => avatarColor(props.order.id))
const glyph = computed(
  () => props.order.emoji?.trim() || props.order.product_name.charAt(0).toUpperCase()
)
const completed = computed(() => props.order.status === 'completed')
const statusLabel = computed(() => t(`status.${props.order.status}`))
</script>

<template>
  <article
    class="flex flex-col overflow-hidden rounded-[20px] border border-outline-variant/20 bg-surface shadow-sm"
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between border-b border-surface-container-highest bg-surface-bright px-4 py-3"
    >
      <div class="flex items-center gap-2">
        <span class="text-[14px] font-semibold text-on-surface">#{{ order.id }}</span>
        <span class="text-[13px] text-on-surface-variant">· {{ $d(new Date(order.created_at), 'short') }}</span>
      </div>
      <div
        class="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
        :class="completed ? 'bg-tertiary-container/30 text-tertiary' : 'bg-surface-container-highest text-on-surface-variant'"
      >
        <component
          :is="completed ? CircleCheck : Undo2"
          :size="12"
          :stroke-width="2.5"
          aria-hidden="true"
        />
        <span>{{ statusLabel }}</span>
      </div>
    </div>

    <!-- Thân -->
    <div class="flex items-start gap-3 px-4 py-4">
      <span
        class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl leading-none"
        :style="{ backgroundColor: `${tileColor}1a`, color: tileColor }"
        aria-hidden="true"
      >
        {{ glyph }}
      </span>
      <div class="flex-1">
        <h3 class="text-[16px] font-semibold leading-tight text-on-surface">{{ order.product_name }}</h3>
        <p class="mt-1 text-[14px] text-on-surface-variant">
          {{ $t('history.qty', { count: order.quantity }) }} · {{ order.total_display }}
        </p>
      </div>
    </div>

    <!-- Footer -->
    <div class="flex gap-3 border-t border-surface-container-highest bg-surface-bright px-4 py-3">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-2 rounded-xl border border-outline-variant/30 bg-surface-container-high py-2 text-[14px] font-semibold text-on-surface transition-colors hover:bg-surface-container-highest"
        @click="$emit('support')"
      >
        <LifeBuoy :size="18" :stroke-width="2" aria-hidden="true" />
        {{ $t('order.support') }}
      </button>
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary py-2 text-[14px] font-semibold text-on-primary transition-opacity hover:opacity-90"
        @click="$emit('detail')"
      >
        {{ $t('order.detail') }}
        <ChevronRight :size="18" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
  </article>
</template>
