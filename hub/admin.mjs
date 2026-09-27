import { HubStore } from './store.mjs';
import { hashPassword } from './auth.mjs';
import { readSecret } from '../scripts/read-secret.mjs';

if (process.argv[2] !== 'create-admin' || !process.argv[3]) {
  console.error('Usage: node hub/admin.mjs create-admin USERNAME (password is read from hidden prompt or stdin)');
  process.exitCode = 1;
} else {
  const store = new HubStore({ path: process.env.HUB_DB_PATH || 'data/hub.sqlite' });
  try {
    const password = await readSecret('管理员密码（至少 12 字节，不会显示）: ');
    const { salt, hash } = await hashPassword(password);
    const user = store.createUser({ name: process.argv[3], salt, hash, role: 'admin', initialAdmin: true });
    console.log(`管理员已初始化: ${user.username}`);
  } catch (error) { console.error(error.code ? error.message : '管理员初始化失败，请检查输入和数据库。'); process.exitCode = 1; }
  finally { store.close(); }
}
