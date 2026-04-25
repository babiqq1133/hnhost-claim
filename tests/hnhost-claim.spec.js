// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000; // 延长到3分钟

function nowStr() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
}

function escapeHtml(text) {
    if (!text) return "";
    return text.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function sendTGReport(page, result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const photoPath = `hnhost_report_${Date.now()}.png`;
    try { if (!page.isClosed()) await page.screenshot({ path: photoPath, fullPage: false }); } catch (e) {}
    
    const reportContent = [
        `🪙 <b>HnHost 每日领取金币报告</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👤 账户：<b><code>${escapeHtml(DISCORD_TOKEN ? DISCORD_TOKEN.substring(0, 25) + '...' : 'N/A')}</code></b>`,
        `📊 状态：${escapeHtml(result)}`,
        `🕒 北京时间：<b><code>${escapeHtml(nowStr())}</code></b>`,
        `━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('caption', reportContent);
    form.append('parse_mode', 'HTML');
    if (fs.existsSync(photoPath)) form.append('photo', fs.createReadStream(photoPath));

    return new Promise((resolve) => {
        const req = https.request({ method: 'POST', host: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendPhoto`, headers: form.getHeaders() }, 
            (res) => { console.log(`📨 TG 推送状态: ${res.statusCode}`); if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath); resolve(); });
        req.on('error', () => resolve());
        form.pipe(req);
    });
}

// 加强版 Token 注入
async function handleDiscordLoginWithToken(page, token) {
    console.log('[*] 正在通过直达链接执行 Token 强制同步注入...');
    await page.context().clearCookies();

    const DIRECT_AUTH_URL = "https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join";

    await page.goto(DIRECT_AUTH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);

    await page.evaluate((t) => {
        const safeSet = (key, value) => {
            try {
                if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
                if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value);
            } catch(e) {}
        };

        safeSet('token', `"${t}"`);
        safeSet('token', JSON.stringify(t));
        window.token = t;
        document.cookie = `token=${encodeURIComponent(t)}; path=/; max-age=3600`;

        // 多执行几次
        for (let i = 0; i < 8; i++) {
            setTimeout(() => safeSet('token', `"${t}"`), i * 300);
        }
    }, token);

    await page.waitForTimeout(15000);
    console.log('🔍 Token 注入完成，准备跳转首页...');
}

// 主测试
test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);

    if (!DISCORD_TOKEN) throw new Error('❌ 缺少 DISCORD_TOKEN 配置');

    const browser = await chromium.launch({ headless: true, proxy: { server: process.env.GOST_PROXY } });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    let status = '执行中';

    try {
        // IP 验证（保持原样）
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            console.log(`✅ 出口 IP 确认：${await res.text()}`);
        } catch {}

        await handleDiscordLoginWithToken(page, DISCORD_TOKEN);

        console.log('🌐 跳转到 HnHost 首页...');
        
        // 更稳健的加载方式
        await page.goto('https://client.hnhost.net/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(15000); // 给 JS 和登录回调足够时间

        // 如果还是未登录，尝试点击 Discord 登录按钮
        const discordLoginBtn = page.locator('button:has-text("Discord"), text=通过 Discord, text=登录').first();
        if (await discordLoginBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log('🔗 检测到 Discord 登录按钮，尝试点击...');
            await discordLoginBtn.click();
            await page.waitForTimeout(10000);
        }

        console.log('🪙 检测领取奖励按钮...');
        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励, text=领取每日, [class*="claim"], [class*="reward"]').first();

        const isVisible = await claimButton.isVisible({ timeout: 25000 }).catch(() => false);

        if (isVisible) {
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(12000);
            const result = await page.locator('text=获得|成功|HN Points|金币').first().innerText().catch(() => '领取完成');
            status = `领取成功！${result}`;
        } else {
            await page.screenshot({ path: `hnhost_debug_${Date.now()}.png`, fullPage: true }).catch(() => {});
            status = '未找到领取奖励按钮（可能今日已领取 或 仍未登录成功）';
        }

        await sendTGReport(page, status);

    } catch (e) {
        console.log(`❌ 异常: ${e.message}`);
        status = `脚本异常: ${e.message}`;
        await sendTGReport(page, status);
    } finally {
        await browser.close();
    }
});
