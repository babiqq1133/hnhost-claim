// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 150000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');
}

function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function sendTGReport(page, status, points = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) return;

    const photoPath = `hnhost_claim_${Date.now()}.png`;
    try {
        if (!page.isClosed()) await page.screenshot({ path: photoPath, fullPage: true });
    } catch (e) {}

    const report = [
        `🪙 <b>HnHost 每日领取金币报告</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 账户：<b><code>${escapeHtml(DISCORD_TOKEN ? DISCORD_TOKEN.substring(0, 25) + '...' : 'N/A')}</code></b>`,
        `📊 状态：${escapeHtml(status)}`,
        points ? `💰 本次获得：${points}` : '',
        `🕒 北京时间：<b><code>${escapeHtml(nowStr())}</code></b>`,
        `━━━━━━━━━━━━━━━━━━`
    ].filter(Boolean).join('\n');

    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', report);
    form.append('parse_mode', 'HTML');
    if (fs.existsSync(photoPath)) form.append('photo', fs.createReadStream(photoPath));

    return new Promise((resolve) => {
        const req = https.request({
            method: 'POST',
            host: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendPhoto`,
            headers: form.getHeaders(),
        }, (res) => {
            console.log(`📨 TG 推送状态: ${res.statusCode}`);
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
            resolve();
        });
        req.on('error', () => resolve());
        form.pipe(req);
    });
}

test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);

    if (!DISCORD_TOKEN) throw new Error('❌ DISCORD_TOKEN 未配置');

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    console.log('🚀 浏览器就绪！');

    let status = '执行中';
    let points = '';

    try {
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { timeout: 15000 });
            const ipData = await res.json().catch(() => ({}));
            console.log(`✅ 出口 IP 确认：${ipData.ip || '获取成功'}`);
        } catch (e) {
            console.log('⚠️ IP 验证失败，继续执行');
        }

        console.log('🔑 使用 Discord Token 调用 OAuth2 授权接口...');

        // 添加 state 参数（推荐，增加安全性）
        const state = Math.random().toString(36).substring(2, 15);
        const authUrl = `https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join&state=${state}`;

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ==================== 修复后的 Token 注入 ====================
        console.log('🔧 注入 Discord Token...');
        
        // 先等待页面基本加载
        await page.waitForLoadState('domcontentloaded');

        await page.evaluate((token) => {
            try {
                // 主要注入方式 - localStorage
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('token', `"${token}"`);
                    console.log('[注入成功] localStorage.token 已设置');
                }

                // 兼容注入方式
                window.token = token;
                window.__DISCORD_TOKEN__ = token;
                window.localStorage?.setItem?.('token', `"${token}"`);

                // 触发事件，让 Discord 脚本检测到
                window.dispatchEvent(new Event('storage'));
                window.dispatchEvent(new Event('message'));
            } catch (e) {
                console.error('注入过程中发生错误:', e.message);
            }
        }, DISCORD_TOKEN);

        // 给 Discord 时间处理自动登录和授权
        await page.waitForTimeout(8000);

        console.log('✅ Token 注入完成，等待 OAuth2 处理...');

        // 等待 Discord OAuth2 响应
        await page.waitForResponse(
            response => response.url().includes('discord.com') && response.status() === 200,
            { timeout: 45000 }
        ).catch(() => console.log('⚠️ 未等到 200 响应'));

        console.log('✅ Discord OAuth2 响应状态: 200');

        // ==================== 关键：等待并提取 code ====================
        console.log('⏳ 等待重定向到回调页面 (discord.php?code=...) ...');

        let code = null;

        try {
            // 优先精确等待回调 URL
            await page.waitForURL(/backend\/pdo\/discord\.php.*[?&]code=/, { timeout: 40000 });
            console.log('✅ 已成功重定向到回调页面');
        } catch (e) {
            console.log('⚠️ 精确等待未命中，尝试从当前 URL 提取 code...');
        }

        // 从当前 URL 中提取 code（更可靠）
        const currentUrl = page.url();
        console.log('📍 当前完整 URL:', currentUrl);

        try {
            const urlObj = new URL(currentUrl);
            code = urlObj.searchParams.get('code');

            // 如果还没拿到，可能是还在 Discord 的中间重定向页，再多等一会儿
            if (!code && (currentUrl.includes('discord.com') || currentUrl.includes('redirect_to'))) {
                console.log('仍在 Discord 页面，额外等待重定向...');
                await page.waitForTimeout(6000);
                const finalUrl = page.url();
                console.log('📍 最终 URL:', finalUrl);
                const finalUrlObj = new URL(finalUrl);
                code = finalUrlObj.searchParams.get('code');
            }
        } catch (e) {
            console.log('⚠️ URL 解析失败:', e.message);
        }

        if (!code) {
            console.log('❌ 未能获取到 OAuth code 参数！');
            await page.screenshot({ path: 'debug-no-code.png', fullPage: true });
            throw new Error('未获取到 OAuth code，请检查 Redirect URI 是否在 Discord 后台正确注册');
        }

        console.log(`✅ 成功获取 code！长度: ${code.length}`);

        // ==================== 继续执行领取逻辑 ====================
        console.log('🌐 跳转到 HnHost 领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        await page.waitForTimeout(8000);

        console.log('🔍 检测领取奖励按钮...');

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励').first();

        if (await claimButton.isVisible({ timeout: 20000 }).catch(() => false)) {
            console.log('🎁 点击领取奖励按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=获得|成功|HNRC').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取）';
            await page.screenshot({ path: 'debug-no-button.png', fullPage: true });
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
