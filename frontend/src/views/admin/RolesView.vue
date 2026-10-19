<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { createRole, deleteRole, listPermissions, listRoles, setRolePermissions, updateRole } from '@/api/admin'
import type { Permission, Role } from '@/api/types'

/** 后端 GET /roles 返回带 permissions 关联的角色 */
interface RoleRow extends Role {
  permissions?: Permission[]
}

interface TreeNode {
  label: string
  code?: string
  children?: TreeNode[]
}

/** el-tree 实例所需的最小接口 */
interface PermTreeRef {
  setCheckedKeys(keys: Array<string | number>): void
  getCheckedKeys(leafOnly?: boolean): Array<string | number>
  getHalfCheckedKeys(): Array<string | number>
}

const MODULE_LABELS: Record<string, string> = {
  user: '用户管理',
  role: '角色权限',
  config: '系统配置',
  space: '空间管理',
  seat: '座位',
  room: '整教室预约',
  workorder: '物业报修',
  stats: '运营统计',
  audit: '审计日志',
  other: '其他',
}

const loading = ref(false)
const saving = ref(false)
const roles = ref<RoleRow[]>([])
const permissions = ref<Permission[]>([])
const selectedRole = ref<RoleRow | null>(null)
const treeRef = ref<PermTreeRef | null>(null)

const allPermCodes = computed(() => new Set(permissions.value.map((p) => p.code)))

/** 权限树：按权限码模块前缀（第一个点之前）分组 */
const treeData = computed<TreeNode[]>(() => {
  const groups: Record<string, TreeNode> = {}
  for (const p of permissions.value) {
    const mod = p.code.includes('.') ? p.code.split('.')[0] : 'other'
    if (!groups[mod]) {
      groups[mod] = { label: MODULE_LABELS[mod] || mod, code: `__group__${mod}`, children: [] }
    }
    groups[mod].children!.push({ label: p.name, code: p.code })
  }
  return Object.values(groups)
})

function applyCheckedKeys(role: RoleRow) {
  nextTick(() => {
    treeRef.value?.setCheckedKeys((role.permissions || []).map((p) => p.code))
  })
}

function selectRole(row: RoleRow) {
  selectedRole.value = row
  applyCheckedKeys(row)
}

/** permissions 异步加载完成后补一次勾选，避免竞态导致勾选丢失 */
watch(
  () => [permissions.value, selectedRole.value] as const,
  () => {
    if (selectedRole.value) applyCheckedKeys(selectedRole.value)
  },
)

async function loadRoles() {
  loading.value = true
  try {
    roles.value = (await listRoles()) as RoleRow[]
    if (!selectedRole.value && roles.value.length) selectRole(roles.value[0])
  } finally {
    loading.value = false
  }
}

async function loadPermissions() {
  try {
    permissions.value = await listPermissions()
  } catch {
    /* 已由拦截器统一提示 */
  }
}

async function savePermissions() {
  if (!selectedRole.value || !treeRef.value) return
  saving.value = true
  try {
    const checked = treeRef.value.getCheckedKeys() as string[]
    const half = treeRef.value.getHalfCheckedKeys() as string[]
    const codes = [...checked, ...half].filter((c) => allPermCodes.value.has(c))
    await setRolePermissions(selectedRole.value.id, codes)
    ElMessage.success('角色权限已保存')
    const prevId = selectedRole.value.id
    await loadRoles()
    const updated = roles.value.find((r) => r.id === prevId)
    if (updated) selectRole(updated)
  } finally {
    saving.value = false
  }
}

/* ===== 角色新建 / 编辑 / 删除 ===== */
const roleDialog = reactive({ visible: false, mode: 'create' as 'create' | 'edit', id: 0 })
const roleFormRef = ref<FormInstance>()
const roleForm = reactive({ code: '', name: '', description: '' })

const roleRules: FormRules = {
  code: [{ required: true, message: '请输入角色编码', trigger: 'blur' }],
  name: [{ required: true, message: '请输入角色名称', trigger: 'blur' }],
}

function openRoleCreate() {
  roleDialog.mode = 'create'
  roleDialog.id = 0
  Object.assign(roleForm, { code: '', name: '', description: '' })
  roleDialog.visible = true
}

function openRoleEdit(row: RoleRow) {
  roleDialog.mode = 'edit'
  roleDialog.id = row.id
  Object.assign(roleForm, { code: row.code, name: row.name, description: row.description })
  roleDialog.visible = true
}

async function submitRole() {
  const valid = await roleFormRef.value?.validate().then(() => true).catch(() => false)
  if (!valid) return
  if (roleDialog.mode === 'create') {
    await createRole({ code: roleForm.code, name: roleForm.name, description: roleForm.description || undefined })
    ElMessage.success('角色创建成功')
  } else {
    await updateRole(roleDialog.id, { name: roleForm.name, description: roleForm.description })
    ElMessage.success('角色已更新')
  }
  roleDialog.visible = false
  await loadRoles()
}

async function handleDelete(row: RoleRow) {
  try {
    await ElMessageBox.confirm(`确定删除角色「${row.name}」（${row.code}）吗？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await deleteRole(row.id)
  ElMessage.success('角色已删除')
  if (selectedRole.value?.id === row.id) selectedRole.value = null
  await loadRoles()
}

onMounted(() => {
  loadRoles()
  loadPermissions()
})
</script>

<template>
  <div class="page-container">
    <el-row :gutter="16">
      <el-col :span="9">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>角色列表</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openRoleCreate">新建角色</el-button>
            </div>
          </template>
          <el-table v-loading="loading" :data="roles" highlight-current-row size="small" @row-click="selectRole">
            <el-table-column prop="code" label="编码" width="110" />
            <el-table-column prop="name" label="名称" min-width="100" />
            <el-table-column prop="description" label="描述" min-width="130" show-overflow-tooltip />
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click.stop="openRoleEdit(row)">编辑</el-button>
                <el-button link type="danger" @click.stop="handleDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="15">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>权限配置：{{ selectedRole ? `${selectedRole.name}（${selectedRole.code}）` : '请选择角色' }}</span>
              <el-button type="primary" size="small" :loading="saving" :disabled="!selectedRole" @click="savePermissions">
                保存权限
              </el-button>
            </div>
          </template>
          <el-empty v-if="!selectedRole" description="请先选择左侧角色" :image-size="60" />
          <el-tree
            v-else
            ref="treeRef"
            :data="treeData"
            node-key="code"
            show-checkbox
            default-expand-all
            :props="{ label: 'label', children: 'children' }"
            class="perm-tree"
          />
        </el-card>
      </el-col>
    </el-row>

    <!-- 新建 / 编辑角色 -->
    <el-dialog v-model="roleDialog.visible" :title="roleDialog.mode === 'create' ? '新建角色' : '编辑角色'" width="460px">
      <el-form ref="roleFormRef" :model="roleForm" :rules="roleRules" label-width="90px">
        <el-form-item label="角色编码" prop="code">
          <el-input v-model="roleForm.code" :disabled="roleDialog.mode === 'edit'" placeholder="如 room_admin" />
        </el-form-item>
        <el-form-item label="角色名称" prop="name">
          <el-input v-model="roleForm.name" placeholder="如 教室管理员" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="roleForm.description" type="textarea" :rows="3" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitRole">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.perm-tree {
  padding: 4px 8px;
}
</style>
