<template>
  <div class="mb-4 flex flex-col gap-3 rounded-lg bg-primary-50 p-3 dark:bg-primary-900/20 md:flex-row md:items-center md:justify-between">
    <div class="flex flex-wrap items-center gap-2">
      <span v-if="selectedIds.length > 0" class="text-sm font-medium text-primary-900 dark:text-primary-100">
        {{ t('admin.accounts.bulkActions.selected', { count: selectedIds.length }) }}
      </span>
      <span v-else class="text-sm font-medium text-primary-900 dark:text-primary-100">
        {{ t('admin.accounts.bulkEdit.title') }}
      </span>
      <template v-if="selectedIds.length > 0">
        <button
          type="button"
          @click="$emit('select-page')"
          class="text-xs font-medium text-primary-700 hover:text-primary-800 dark:text-primary-300 dark:hover:text-primary-200"
        >
          {{ t('admin.accounts.bulkActions.selectCurrentPage') }}
        </button>
        <span class="text-gray-300 dark:text-primary-800">•</span>
        <button
          v-if="canEditAllFiltered"
          type="button"
          @click="$emit('edit-filtered')"
          class="text-xs font-medium text-primary-700 hover:text-primary-800 dark:text-primary-300 dark:hover:text-primary-200"
        >
          {{ t('admin.accounts.bulkActions.editAllFiltered', { count: total }) }}
        </button>
        <span v-if="canEditAllFiltered" class="text-gray-300 dark:text-primary-800">•</span>
        <button
          type="button"
          @click="$emit('clear')"
          class="text-xs font-medium text-primary-700 hover:text-primary-800 dark:text-primary-300 dark:hover:text-primary-200"
        >
          {{ t('admin.accounts.bulkActions.clear') }}
        </button>
      </template>
    </div>
    <div class="flex flex-wrap gap-2">
      <template v-if="selectedIds.length > 0">
        <button type="button" @click="$emit('delete')" class="btn btn-danger btn-sm">{{ t('admin.accounts.bulkActions.delete') }}</button>
        <button type="button" @click="$emit('reset-status')" class="btn btn-secondary btn-sm">{{ t('admin.accounts.bulkActions.resetStatus') }}</button>
        <button type="button" @click="$emit('refresh-token')" class="btn btn-secondary btn-sm">{{ t('admin.accounts.bulkActions.refreshToken') }}</button>
        <button type="button" @click="$emit('toggle-schedulable', true)" class="btn btn-success btn-sm">{{ t('admin.accounts.bulkActions.enableScheduling') }}</button>
        <button type="button" @click="$emit('toggle-schedulable', false)" class="btn btn-warning btn-sm">{{ t('admin.accounts.bulkActions.disableScheduling') }}</button>
        <button type="button" @click="$emit('edit-selected')" class="btn btn-primary btn-sm">{{ t('admin.accounts.bulkActions.edit') }}</button>
      </template>
      <button
        type="button"
        :disabled="total === 0"
        @click="$emit('edit-filtered')"
        class="btn btn-primary btn-sm"
      >
        {{ t('admin.accounts.bulkActions.editAllFiltered', { count: total }) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  selectedIds: number[]
  total?: number
}>(), {
  total: 0
})

defineEmits<{
  delete: []
  'edit-selected': []
  'edit-filtered': []
  clear: []
  'select-page': []
  'toggle-schedulable': [schedulable: boolean]
  'reset-status': []
  'refresh-token': []
}>()

const { t } = useI18n()
const canEditAllFiltered = computed(() => props.total > props.selectedIds.length)
</script>
