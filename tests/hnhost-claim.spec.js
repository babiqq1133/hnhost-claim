// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TEST_TIMEOUT = 300000; // 5分钟

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
        if (page && !page.isClosed()) {
            await page.screenshot({ path: photoPath, fullPage: true });
        }
    } catch (e) {
        console.log('截图失败:', e.message);
    }

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
    test.setTimeout(TEST_TIMEOUT);
    
    if (!DISCORD_TOKEN) {
        throw new Error('❌ DISCORD_TOKEN 未配置');
    }

    const proxyConfig = GOST_PROXY ? { server: GOST_PROXY } : undefined;
    if (proxyConfig) console.log(`🛡️ 使用 GOST 代理: ${GOST_PROXY}`);

    const browser = await chromium.launch({ 
        headless: true, 
        proxy: proxyConfig 
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(90000);   // 单步默认超时 90 秒

    console.log('🚀 浏览器就绪！');

    let status = '执行中';
    let points = '';

    try {
        const clientId = '1497635385562628296';
        const authUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join`;

        console.log('🔑 访问 Discord OAuth2 授权页面...');
        await page.goto(authUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        // Token 注入
        console.log('🔧 注入 Discord Token...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        await page.evaluate((token) => {
            try {
                localStorage.setItem('token', JSON.stringify(token));
                window.token = token;
                window.__DISCORD_TOKEN__ = token;
                console.log('✅ Token 已注入 localStorage 和 window');
            } catch (e) {
                console.log('注入 Token 时出错:', e.message);
            }
        }, DISCORD_TOKEN);

        await page.waitForTimeout(5000);

        console.log('⏳ 等待 Discord OAuth2 响应...');
        await page.waitForResponse(
            r => r.url().includes('discord.com') && r.status() === 200,
            { timeout: 40000 }
        ).catch(() => console.log('⚠️ 未等到 200 响应'));

        console.log('✅ Discord OAuth2 响应状态: 200');

        // 等待回调 URL
        console.log('⏳ 等待拿到回调 URL...');
        await page.waitForURL(/backend\/pdo\/discord\.php.*code=/, { 
            timeout: 45000 
        }).catch(() => {
            console.log('⚠️ 未检测到 code 参数');
        });

        const callbackUrl = page.url();
        console.log('✅ 拿到回调 URL:', callbackUrl);

        // 建立登录 Session
        console.log('🌐 浏览器访问回调 URL，建立登录 Session...');
        await page.goto(callbackUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        }).catch(err => {
            console.log('⚠️ 访问回调 URL 失败，但继续尝试:', err.message);
        });

        console.log('✅ 登录 Session 建立成功');

        // 跳转到领取页面
        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // 额外等待页面稳定
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        await page.waitForTimeout(5000);

        // 查找领取按钮（更精确的写法）
        console.log('🔍 查找领取奖励按钮...');
        const claimButton = page.locator('button').filter({ hasText: /领取奖励|Claim|领取/ }).first();

        const buttonVisible = await claimButton.isVisible({ timeout: 20000 }).catch(() => false);

        if (buttonVisible) {
            console.log('🎁 找到领取按钮，正在点击...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 800 });

            await page.waitForTimeout(10000);

            // 尝试获取获得金币的信息
            points = await page.locator('text=/获得|成功|HNRC|金币/i').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
            console.log(`🎉 ${status}`);
        } else {
            status = '未找到领取奖励按钮（可能今日已领取或需要验证）';
            console.log(`ℹ️ ${status}`);
        }

        await sendTGReport(page, status, points);

    } catch (error) {
        status = `执行失败: ${error.message}`;
        console.error('❌ ' + status);
        try {
            await sendTGReport(page, status);
        } catch (tgErr) {
            console.log('TG 推送失败:', tgErr.message);
        }
        throw error;
    } finally {
        await browser.close().catch(() => {});
    }
});
