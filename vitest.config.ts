import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.spec.ts'],
        environment: 'node',
        // 集成测试会启动真实本地 server 并涉及真实计时（退避/熔断窗口），
        // 给予宽松超时，避免 CI 抖动导致误报。
        testTimeout: 20_000,
        hookTimeout: 20_000,
        // 多进程隔离：集成测试中的 http server / 连接池互不干扰
        // （vitest 5 移除了 poolOptions；forks 池默认即非 singleFork）
        pool: 'forks',
        sequence: { concurrent: false },
    },
});
