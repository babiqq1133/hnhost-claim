// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 200000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai', 
        hour12: false 
    }).replace(/\//g, '-');
}

function escapeHtml(text) {
    if (!text) return "";
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function sendTGReport(page, result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;

    const photoPath = `hnhost_report_${Date.now()}.png`;
    try {
        if (!page.isClosed()) {
            await page.screenshot({ path: photoPath, fullPage: true });
        }
    } catch (e) {}

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

    if (fs.existsSync(photoPath)) {
        form.append('photo', fs.createReadStream(photoPath));
    }

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

// Token 注入（保持不变）
async function handleDiscordLoginWithToken(page, token) {
    console.log('[*] 正在通过直达链接执行 Token 强制同步注入...');
    await page.context().clearCookies();

    const DIRECT_AUTH_URL = "https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join";

    await page.goto(DIRECT_AUTH_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(8000);

    console.log('💉 开始注入 Token...');
    await page.evaluate((t) => {
        const injectToken = () => {
            try {
                if (typeof localStorage !== "undefined") localStorage.setItem("token", `"${t}"`);
                if (typeof sessionStorage !== "undefined") sessionStorage.setItem("token", `"${t}"`);
                window.token = t; window.discordToken = t;
                document.cookie = `token=${encodeURIComponent(t)}; path=/; max-age=3600`;
            } catch (err) {}
        };
        injectToken();
        for (let i = 1; i <= 6; i++) setTimeout(injectToken, i * 500);
        setTimeout(() => location.reload(), 6000);
    }, token);

    await page.waitForTimeout(18000);
    console.log('✅ Token 注入阶段完成');
}

// 主测试
test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);
    if (!DISCORD_TOKEN) throw new Error('❌ 缺少 DISCORD_TOKEN 配置');

    const browser = await chromium.launch({
        headless: true,
        proxy: process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined,
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    let status = '执行中';

    try {
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            console.log(`✅ 出口 IP 确认：${await res.text()}`);
        } catch (e) {}

        await handleDiscordLoginWithToken(page, DISCORD_TOKEN);

        console.log('🌐 跳转到 HnHost 首页...');
        await page.goto('https://client.hnhost.net/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(10000);

        // 点击伺服器面板
        console.log('🔍 点击伺服器面板入口...');
        const panelLink = page.locator('text=伺服器面板').first();
        if (await panelLink.isVisible({ timeout: 10000 }).catch(() => false)) {
            await panelLink.click();
            await page.waitForTimeout(8000);
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        }

        // 尝试返回主仪表盘（关键）
        console.log('🔄 尝试返回主仪表盘...');
        const dashboardLinks = page.locator('text=主頁, text=首页, text=仪表盘, text=控制面板, text=Dashboard').first();
        if (await dashboardLinks.isVisible({ timeout: 8000 }).catch(() => false)) {
            await dashboardLinks.click();
            await page.waitForTimeout(8000);
        }

        // 多轮滚动到底部（领取按钮在最下方）
        console.log('📜 多轮滚动到底部，确保按钮出现...');
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(5000);
        }

        console.log('🪙 检测领取奖励按钮...');

        // 针对你截图的精准选择器
        const claimButton = page.locator('button:has-text("领取奖励")')
            .or(page.getByRole('button', { name: /领取奖励/i }))
            .or(page.locator('text=领取每日登录奖励'))
            .first();

        const isVisible = await claimButton.waitFor({ state: 'visible', timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        if (isVisible) {
            console.log('🎁 找到领取奖励按钮，点击...');
            await claimButton.scrollIntoViewIfNeeded();
            await page.waitForTimeout(2000);
            await claimButton.click({ delay: 1000 });

            await page.waitForTimeout(10000);

            const successText = await page.locator('text=获得|成功|HN Points|金币|+10|领取成功')
                .first().innerText().catch(() => '领取完成');

            status = `领取成功！ ${successText}`;
            console.log(`✅ ${status}`);
        } else {
            await page.screenshot({ path: `hnhost_debug_${Date.now()}.png`, fullPage: true });
            console.log('💾 已保存调试截图 hnhost_debug_*.png');
            status = '未找到领取奖励按钮（可能今日已领取）';
            console.log('❌ ' + status);
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
