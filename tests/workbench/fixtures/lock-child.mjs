// 子进程：抢项目目录的锁，抢到就持有一段时间再释放。输出 got / busy / error。
// 用法：node lock-child.mjs <dir> <holdMs>
import { acquireLock } from '../../../lib/workbench/txn.mjs';

const [dir, holdMs] = process.argv.slice(2);
try {
  const lock = acquireLock(dir, { purpose: `child-${process.pid}` });
  console.log('got');
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, Number(holdMs));
} catch (e) {
  console.log(e.status === 423 ? 'busy' : `error ${e.message}`);
  process.exit(0);
}
