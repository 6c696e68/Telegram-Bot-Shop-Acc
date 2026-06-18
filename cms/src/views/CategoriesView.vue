<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import Icon from '@/components/Icon.vue'
import { AVAILABLE_LOCALES } from '@/i18n'

interface Category {
  id: number
  name: string
  description: string | null
  content: string | null
  emoji: string | null
  image_data: string | null
  sort_order: number
  is_visible: number
  product_count: number
  available_count: number
  total_count: number
  created_at: string
  updated_at: string
}

interface CategoryForm {
  name: string
  description: string
  content: string
  emoji: string
  image_data: string
  sort_order: number
  is_visible: number
}

interface TranslationForm {
  name: string
  description: string
  content: string
}

const categories = ref<Category[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const success = ref('')
const showModal = ref(false)
const editingId = ref<number | null>(null)
const activeLang = ref(AVAILABLE_LOCALES[0] ?? 'vi')

const form = ref<CategoryForm>(emptyForm())
const translations = ref<Record<string, TranslationForm>>(emptyTranslations())

const modalTitle = computed(() => (editingId.value ? 'Sửa danh mục' : 'Thêm danh mục'))

function emptyForm(): CategoryForm {
  return {
    name: '',
    description: '',
    content: '',
    emoji: '',
    image_data: '',
    sort_order: 0,
    is_visible: 1,
  }
}

function emptyTranslations(): Record<string, TranslationForm> {
  const out: Record<string, TranslationForm> = {}
  for (const lang of AVAILABLE_LOCALES) {
    out[lang] = { name: '', description: '', content: '' }
  }
  return out
}

async function fetchCategories(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await api.get<Category[]>('/product-types?sort=sort_order&order=asc&limit=100')
    if (res.success && res.data) {
      categories.value = res.data
    } else {
      error.value = res.error || 'Không tải được danh mục'
    }
  } catch {
    error.value = 'Không tải được danh mục'
  } finally {
    loading.value = false
  }
}

async function fetchTranslations(id: number): Promise<void> {
  translations.value = emptyTranslations()
  const res = await api.get<Array<{ lang: string; name: string | null; description: string | null; content: string | null }>>(
    `/product-types/${id}/translations`
  )
  if (!res.success || !res.data) return
  for (const row of res.data) {
    if (row.lang in translations.value) {
      translations.value[row.lang] = {
        name: row.name ?? '',
        description: row.description ?? '',
        content: row.content ?? '',
      }
    }
  }
}

function openCreate(): void {
  editingId.value = null
  form.value = emptyForm()
  translations.value = emptyTranslations()
  activeLang.value = AVAILABLE_LOCALES[0] ?? 'vi'
  error.value = ''
  success.value = ''
  showModal.value = true
}

async function openEdit(category: Category): Promise<void> {
  editingId.value = category.id
  form.value = {
    name: category.name,
    description: category.description ?? '',
    content: category.content ?? '',
    emoji: category.emoji ?? '',
    image_data: category.image_data ?? '',
    sort_order: category.sort_order,
    is_visible: category.is_visible,
  }
  activeLang.value = AVAILABLE_LOCALES[0] ?? 'vi'
  error.value = ''
  success.value = ''
  showModal.value = true
  await fetchTranslations(category.id)
}

function closeModal(): void {
  showModal.value = false
}

function validateForm(): string | null {
  const name = form.value.name.trim()
  if (!name) return 'Tên danh mục là bắt buộc'
  if (name.length > 200) return 'Tên tối đa 200 ký tự'
  if (form.value.description.length > 2000) return 'Mô tả tối đa 2000 ký tự'
  if (form.value.content.length > 5000) return 'Nội dung tối đa 5000 ký tự'
  for (const lang of AVAILABLE_LOCALES) {
    const tr = translations.value[lang]
    if (!tr) continue
    const hasAny = tr.name.trim() || tr.description.trim() || tr.content.trim()
    if (!hasAny) continue
    if (!tr.name.trim()) return `Bản dịch ${lang.toUpperCase()} cần tên`
    if (tr.name.trim().length > 200) return `Tên dịch ${lang.toUpperCase()} tối đa 200 ký tự`
    if (tr.description.length > 2000) return `Mô tả dịch ${lang.toUpperCase()} tối đa 2000 ký tự`
    if (tr.content.length > 5000) return `Nội dung dịch ${lang.toUpperCase()} tối đa 5000 ký tự`
  }
  return null
}

async function saveTranslations(id: number): Promise<void> {
  for (const lang of AVAILABLE_LOCALES) {
    const tr = translations.value[lang]
    if (!tr) continue
    const hasAny = tr.name.trim() || tr.description.trim() || tr.content.trim()
    if (!hasAny) continue
    await api.put(`/product-types/${id}/translations`, {
      lang,
      name: tr.name.trim(),
      description: tr.description.trim() || null,
      content: tr.content.trim() || null,
    })
  }
}

async function saveCategory(): Promise<void> {
  const validation = validateForm()
  if (validation) {
    error.value = validation
    return
  }

  saving.value = true
  error.value = ''
  try {
    const payload = {
      name: form.value.name.trim(),
      description: form.value.description.trim() || null,
      content: form.value.content.trim() || null,
      emoji: form.value.emoji.trim() || null,
      image_data: form.value.image_data.trim() || null,
      sort_order: Number.isInteger(form.value.sort_order) ? form.value.sort_order : 0,
      is_visible: form.value.is_visible ? 1 : 0,
    }

    const res = editingId.value
      ? await api.put<Category>(`/product-types/${editingId.value}`, payload)
      : await api.post<Category>('/product-types', payload)

    if (!res.success || !res.data) {
      error.value = res.error || 'Không lưu được danh mục'
      return
    }

    await saveTranslations(res.data.id)
    success.value = 'Đã lưu danh mục'
    showModal.value = false
    await fetchCategories()
  } catch {
    error.value = 'Không lưu được danh mục'
  } finally {
    saving.value = false
  }
}

async function toggleVisible(category: Category): Promise<void> {
  const next = category.is_visible ? 0 : 1
  const res = await api.put<Category>(`/product-types/${category.id}`, { is_visible: next })
  if (res.success) {
    category.is_visible = next
  } else {
    error.value = res.error || 'Không cập nhật được trạng thái'
  }
}

async function deleteCategory(category: Category): Promise<void> {
  if (category.product_count > 0) {
    error.value = 'Không thể xoá danh mục còn sản phẩm con'
    return
  }
  if (!confirm(`Xoá danh mục "${category.name}"?`)) return
  const res = await api.delete<{ id: number }>(`/product-types/${category.id}`)
  if (res.success) {
    await fetchCategories()
  } else {
    error.value = res.error || 'Không xoá được danh mục'
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('vi-VN')
}

onMounted(fetchCategories)
</script>

<template>
  <div class="animate-in">
    <div class="page-head">
      <div>
        <h1 class="page-title">Danh mục</h1>
        <p class="page-subtitle">Quản lý danh mục sản phẩm, bản dịch và trạng thái hiển thị.</p>
      </div>
      <button class="btn btn-primary" type="button" @click="openCreate">
        <Icon name="plus" :size="16" />
        Thêm danh mục
      </button>
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <div v-if="success" class="notice notice-success">{{ success }}</div>

    <div class="card overflow-hidden">
      <div v-if="loading" class="state-block">
        <Icon name="refresh" :size="20" />
        <span>Đang tải</span>
      </div>
      <div v-else-if="categories.length === 0" class="state-block state-empty">
        <Icon name="category" :size="32" />
        <p>Chưa có danh mục</p>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th style="width: 56px">ID</th>
            <th>Tên</th>
            <th>Mô tả</th>
            <th class="text-right">Sản phẩm</th>
            <th class="text-right">Kho</th>
            <th>Trạng thái</th>
            <th>Ngày tạo</th>
            <th class="text-right">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="category in categories" :key="category.id" class="row-hover">
            <td class="mono faint">{{ category.id }}</td>
            <td class="ink">
              <span v-if="category.emoji" class="emoji-box">{{ category.emoji }}</span>
              {{ category.name }}
            </td>
            <td class="muted">{{ category.description || '—' }}</td>
            <td class="text-right tabular-nums">{{ category.product_count }}</td>
            <td class="text-right tabular-nums">{{ category.available_count }} / {{ category.total_count }}</td>
            <td>
              <span class="badge" :class="category.is_visible ? 'badge-green' : 'badge-yellow'">
                {{ category.is_visible ? 'Hiển thị' : 'Ẩn' }}
              </span>
            </td>
            <td class="muted nowrap">{{ formatDate(category.created_at) }}</td>
            <td class="text-right">
              <button class="btn btn-ghost btn-sm" type="button" title="Sửa" @click="openEdit(category)">
                <Icon name="edit" :size="15" />
              </button>
              <button class="btn btn-ghost btn-sm" type="button" title="Ẩn/hiện" @click="toggleVisible(category)">
                <Icon :name="category.is_visible ? 'eyeOff' : 'eye'" :size="15" />
              </button>
              <button class="btn btn-ghost btn-sm danger" type="button" title="Xoá" @click="deleteCategory(category)">
                <Icon name="trash" :size="15" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-backdrop" @click.self="closeModal">
      <div class="modal-panel wide">
        <div class="modal-head">
          <h2 class="modal-title">{{ modalTitle }}</h2>
          <button class="icon-btn" type="button" @click="closeModal">
            <Icon name="close" :size="18" />
          </button>
        </div>

        <div class="form-grid">
          <label class="field-block">
            <span class="label">Tên</span>
            <input v-model="form.name" class="field" maxlength="200" />
          </label>
          <label class="field-block">
            <span class="label">Emoji</span>
            <input v-model="form.emoji" class="field" maxlength="16" />
          </label>
          <label class="field-block span-2">
            <span class="label">Mô tả</span>
            <textarea v-model="form.description" class="field textarea" maxlength="2000" />
          </label>
          <label class="field-block span-2">
            <span class="label">Nội dung hiển thị</span>
            <textarea v-model="form.content" class="field textarea" maxlength="5000" />
          </label>
          <label class="field-block">
            <span class="label">Thứ tự</span>
            <input v-model.number="form.sort_order" class="field" type="number" />
          </label>
          <label class="check-row">
            <input v-model.number="form.is_visible" type="checkbox" :true-value="1" :false-value="0" />
            <span>Hiển thị</span>
          </label>
          <label class="field-block span-2">
            <span class="label">Ảnh hoặc data URL</span>
            <input v-model="form.image_data" class="field" />
          </label>
        </div>

        <section class="translation-box">
          <div class="tabs">
            <button
              v-for="lang in AVAILABLE_LOCALES"
              :key="lang"
              type="button"
              class="tab-btn"
              :class="{ active: activeLang === lang }"
              @click="activeLang = lang"
            >
              {{ lang.toUpperCase() }}
            </button>
          </div>
          <div v-if="translations[activeLang]" class="form-grid">
            <label class="field-block span-2">
              <span class="label">Tên dịch</span>
              <input v-model="translations[activeLang].name" class="field" maxlength="200" />
            </label>
            <label class="field-block span-2">
              <span class="label">Mô tả dịch</span>
              <textarea v-model="translations[activeLang].description" class="field textarea" maxlength="2000" />
            </label>
            <label class="field-block span-2">
              <span class="label">Nội dung dịch</span>
              <textarea v-model="translations[activeLang].content" class="field textarea" maxlength="5000" />
            </label>
          </div>
        </section>

        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" @click="closeModal">Huỷ</button>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="saveCategory">
            <Icon name="check" :size="16" />
            {{ saving ? 'Đang lưu' : 'Lưu' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- Page layout ---- */
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}
.page-title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.page-subtitle {
  margin-top: 0.25rem;
  font-size: 0.875rem;
  color: var(--muted);
}

/* ---- Notices ---- */
.notice {
  margin-bottom: 14px;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
}
.notice-error {
  background: var(--red-bg);
  color: var(--red-fg);
}
.notice-success {
  background: var(--green-bg);
  color: var(--green-fg);
}

/* ---- Table helpers ---- */
.text-right {
  text-align: right;
}
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
.ink {
  color: var(--ink);
}
.muted {
  color: var(--muted);
  font-size: 0.75rem;
}
.faint {
  color: var(--faint);
}
.nowrap {
  white-space: nowrap;
}
.overflow-hidden {
  overflow: hidden;
}
.emoji-box {
  display: inline-flex;
  width: 28px;
}
.danger {
  color: var(--red-fg);
}

/* ---- State blocks ---- */
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 3rem 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
.state-empty {
  color: var(--faint);
}

/* ---- Modal ---- */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.4);
}
.modal-panel {
  background: var(--surface);
  border-radius: var(--radius-lg);
  max-height: 85vh;
  overflow-y: auto;
  padding: 1.5rem;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
}
.modal-panel.wide {
  width: min(860px, calc(100vw - 32px));
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}
.modal-title {
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--ink);
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover {
  background: var(--surface-alt);
  color: var(--ink);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

/* ---- Form ---- */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.span-2 {
  grid-column: span 2;
}
.field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.textarea {
  min-height: 92px;
  resize: vertical;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 28px;
}

/* ---- Translation tabs ---- */
.translation-box {
  margin-top: 18px;
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.tab-btn {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 12px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.tab-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: span 1;
  }
}
</style>
