<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus, Search } from '@element-plus/icons-vue'
import { createUser, listRoles, listUsers, updateUser } from '@/api/admin'
import type { Role, User } from '@/api/types'

/* ===== 列表 ===== */
const loading = ref(false)
const users = ref<User[]>([])
const total = ref(0)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(10)
const roles = ref<Role[]>([])

async function loadRoles() {
  try {
    roles.value = await listRoles()
  } catch {
    /* 无 role.manage 权限时忽略，角色多选为空 */
  }
}

async function load() {
  loading.value = true
  try {
    const res = await listUsers({ keyword: keyword.value || undefined, page: page.value, pageSize: pageSize.value })
    users.value = res.items
    total.value = res.total
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  load()
}

function handleSizeChange() {
  page.value = 1
  load()
}

/* ===== 新建 / 编辑 ===== */
const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()
const form = reactive({
  username: '',
  name: '',
  email: '',
  department: '',
  password: '',
  roleCodes: [] as string[],
})

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入初始密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
}

function openCreate() {
  dialogMode.value = 'create'
  editingId.value = null
  Object.assign(form, { username: '', name: '', email: '', department: '', password: '', roleCodes: [] })
  dialogVisible.value = true
}

function openEdit(row: User) {
  dialogMode.value = 'edit'
  editingId.value = row.id
  Object.assign(form, {
    username: row.username,
    name: row.name,
    email: row.email,
    department: row.department,
    password: '',
    roleCodes: (row.roles || []).map((r) => r.code),
  })
  dialogVisible.value = true
}

async function submit() {
  const valid = await formRef.value?.validate().then(() => true).catch(() => false)
  if (!valid) return
  if (dialogMode.value === 'create') {
    await createUser({
      username: form.username,
      password: form.password,
      name: form.name,
      email: form.email || undefined,
      department: form.department || undefined,
      roleCodes: form.roleCodes,
    })
    ElMessage.success('用户创建成功')
  } else if (editingId.value != null) {
    await updateUser(editingId.value, {
      name: form.name,
      email: form.email,
      department: form.department,
      roleCodes: form.roleCodes,
    })
    ElMessage.success('用户信息已更新')
  }
  dialogVisible.value = false
  load()
}

/* ===== 启用 / 禁用 ===== */
async function handleToggle(row: User) {
  try {
    await updateUser(row.id, { isActive: !row.isActive })
    ElMessage.success(row.isActive ? `已禁用 ${row.username}` : `已启用 ${row.username}`)
    load()
  } catch {
    /* 已由拦截器统一提示 */
  }
}

/* ===== 重置密码 ===== */
const pwdVisible = ref(false)
const pwdUserId = ref<number | null>(null)
const pwdUsername = ref('')
const pwdForm = reactive({ password: '' })
const pwdRef = ref<FormInstance>()

const pwdRules: FormRules = {
  password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
}

function openResetPwd(row: User) {
  pwdUserId.value = row.id
  pwdUsername.value = row.username
  pwdForm.password = ''
  pwdVisible.value = true
}

async function submitResetPwd() {
  const valid = await pwdRef.value?.validate().then(() => true).catch(() => false)
  if (!valid || pwdUserId.value == null) return
  await updateUser(pwdUserId.value, { password: pwdForm.password })
  ElMessage.success(`已重置 ${pwdUsername.value} 的密码`)
  pwdVisible.value = false
}

onMounted(() => {
  load()
  loadRoles()
})
</script>

<template>
  <div class="page-container">
    <el-card shadow="never">
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索用户名 / 姓名"
          clearable
          style="width: 260px"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        >
          <template #append>
            <el-button :icon="Search" @click="handleSearch" />
          </template>
        </el-input>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建用户</el-button>
      </div>

      <el-table v-loading="loading" :data="users" border stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="username" label="用户名" min-width="110" />
        <el-table-column prop="name" label="姓名" min-width="100" />
        <el-table-column prop="email" label="邮箱" min-width="160" show-overflow-tooltip />
        <el-table-column prop="department" label="院系" min-width="120" show-overflow-tooltip />
        <el-table-column label="角色" min-width="150">
          <template #default="{ row }">
            <el-tag v-for="r in row.roles || []" :key="r.id" size="small" class="role-tag">{{ r.name }}</el-tag>
            <span v-if="!(row.roles || []).length" class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-switch :model-value="row.isActive" @change="handleToggle(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="warning" @click="openResetPwd(row)">重置密码</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="handleSizeChange"
        @current-change="load"
      />
    </el-card>

    <!-- 新建 / 编辑用户 -->
    <el-dialog v-model="dialogVisible" :title="dialogMode === 'create' ? '新建用户' : '编辑用户'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" :disabled="dialogMode === 'edit'" placeholder="登录账号" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" placeholder="真实姓名" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="选填" />
        </el-form-item>
        <el-form-item label="院系" prop="department">
          <el-input v-model="form.department" placeholder="选填" />
        </el-form-item>
        <el-form-item v-if="dialogMode === 'create'" label="初始密码" prop="password">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.roleCodes" multiple placeholder="选择角色" style="width: 100%">
            <el-option v-for="r in roles" :key="r.id" :label="`${r.name}（${r.code}）`" :value="r.code" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="pwdVisible" :title="`重置密码：${pwdUsername}`" width="420px">
      <el-form ref="pwdRef" :model="pwdForm" :rules="pwdRules" label-width="90px">
        <el-form-item label="新密码" prop="password">
          <el-input v-model="pwdForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResetPwd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}

.role-tag {
  margin-right: 4px;
}

.muted {
  color: #909399;
}
</style>
