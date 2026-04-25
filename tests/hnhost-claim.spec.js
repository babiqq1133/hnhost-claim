// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000; // 加大超时

function nowStr() { /* 保持不变 */ }
function escapeHtml(text) { /* 保持不变 */ }
async function sendTGReport(page, status, points = '') { /* 保持不变 */ }

test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);

    if (!DISCORD_TOKEN) throw new Error('❌ DISCORD_TOKEN 未配置');

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;

    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    console.log('🚀 浏览器就绪！');

    let status = '执行中';
    let points = '';

    try {
        // IP 验证保持不变...

        console.log('🔑 使用新 Client ID 调用 OAuth2...');
        const clientId = '1497635385562628296';
        const state = Math.random().toString(36).substring(2, 15);

        // 添加 prompt=none 尝试跳过授权确认
        const authUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join&state=${state}&prompt=none`;

        await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 60000 });

        console.log('🔧 注入 Discord Token...');
        await page.evaluate((token) => {
            try {
                localStorage.setItem('token', `"${token}"`);
                window.token = token;
                window.__DISCORD_TOKEN__ = token;
            } catch (e) {}
        }, DISCORD_TOKEN);

        await page.waitForTimeout(8000);

        // 更强的按钮点击 + 刷新尝试
        console.log('⏳ 尝试自动登录/授权...');
        for (let i = 0; i < 2; i++) {
            try {
                await page.locator('button:has-text("登录"), button:has-text("Log In"), [type="submit"]').click({ timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(4000);
            } catch {}
            try {
                await page.locator('button:has-text("授权"), button:has-text("Authorize")').click({ timeout: 8000 }).catch(() => {});
                await page.waitForTimeout(5000);
            } catch {}
        }

        await page.waitForTimeout(10000);

        // 提取 code 的加强版
        let code = null;
        console.log('📍 当前 URL:', page.url());

        try {
            const urlObj = new URL(page.url());
            code = urlObj.searchParams.get('code');
        } catch (e) {}

        if (!code) {
            console.log('仍在 Discord 页面，尝试刷新页面...');
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForTimeout(8000);
            try {
                const urlObj = new URL(page.url());
                code = urlObj.searchParams.get('code');
            } catch (e) {}
        }

        if (!code) {
            console.log('❌ 仍未获取到 code');
            await page.screenshot({ path: 'debug-no-code-final.png', fullPage: true });
            throw new Error('未获取到 OAuth code，请确认 Redirect URI 已正确保存并生效');
        }

        console.log(`✅ 成功获取 code！长度: ${code.length}`);

        // 后面领取逻辑保持不变...
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', { waitUntil: 'networkidle' });

        await page.waitForTimeout(8000);

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励').first();

        if (await claimButton.isVisible({ timeout: 20000 }).catch(() => false)) {
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);
            points = await page.locator('text=获得|成功|HNRC').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取）';
        }

        await sendTGReport(page, status, points);

    } catch (error) {
        status = `执行失败: ${error.message}`;
        console.log('❌ ' + status);
        try { await sendTGReport(page, status); } catch {}
        throw error;
    } finally {
        await browser.close();
    }
});
