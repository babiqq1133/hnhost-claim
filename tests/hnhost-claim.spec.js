// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOST_PROXY = process.env.GOST_PROXY;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
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
    if (!TG_CHAT_ID || !TG_TOKEN) {
        console.log('⚠️ TG_BOT 未配置，跳过推送');
        return;
    }

    const photoPath = `hnhost_report_${Date.now()}.png`;
    try {
        if (!page.isClosed()) {
            await page.screenshot({ path: photoPath, fullPage: false });
        }
    } catch (e) {
        console.log(`[-] 截图失败: ${e.message}`);
    }

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

// ==================== 加强版 Token 注入（已修复 localStorage 错误） ====================
async function handleDiscordLoginWithToken(page, token) {
    console.log('[*] 正在通过直达链接执行 Token 强制同步注入...');

    await page.context().clearCookies();

    const DIRECT_AUTH_URL = "https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join";

    await page.goto(DIRECT_AUTH_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(8000);   // 重要：等待页面完全加载

    // 安全注入（避免 localStorage 未定义）
    await page.evaluate((t) => {
        const safeInject = () => {
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('token', JSON.stringify(t));
                    localStorage.setItem('token', `"${t}"`);
                }
                // 备用方式
                window.token = t;
                document.cookie = `token=${encodeURIComponent(t)}; path=/`;
            } catch (e) {
                console.log('注入时小错误:', e.message);
            }
        };

        safeInject();
        // 多执行几次
        for (let i = 0; i < 5; i++) {
            setTimeout(safeInject, i * 400);
        }

        // 最终刷新页面
        setTimeout(() => {
            location.reload();
        }, 5000);
    }, token);

    await page.waitForTimeout(16000); // 等待注入 + 跳转 + 登录同步

    console.log('🔍 检查登录状态...');
    const checkResult = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return {
            hasLoginHint: text.includes('账户') || text.includes('账号') || text.includes('HN POINTS'),
            urlContains: location.href.includes('hnhost.net'),
            hasToken: typeof localStorage !== 'undefined' && !!localStorage.getItem('token')
        };
    });
    console.log(`登录检查: ${JSON.stringify(checkResult)}`);
}

// ==================== 主测试 ====================
test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);

    if (!DISCORD_TOKEN) {
        throw new Error('❌ 缺少 DISCORD_TOKEN 配置');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        proxyConfig = { server: process.env.GOST_PROXY };
        console.log(`🛡️ 使用 GOST 代理: ${process.env.GOST_PROXY}`);
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);

    let status = '执行中';

    try {
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            console.log(`✅ 出口 IP 确认：${body.trim()}`);
        } catch (e) {
            console.log('⚠️ IP 验证失败:', e.message);
        }

        await handleDiscordLoginWithToken(page, DISCORD_TOKEN);

        console.log('🌐 跳转到 HnHost 首页...');
        await page.goto('https://client.hnhost.net/', { 
            waitUntil: 'networkidle', 
            timeout: 90000 
        });

        await page.waitForTimeout(12000); // 关键等待时间

        console.log('🪙 检测领取奖励按钮...');

        const claimButton = page.locator(`
            button:has-text("领取奖励"),
            button:has-text("領取獎勵"),
            button:has-text("领取每日"),
            text=领取奖励,
            text=领取每日登录奖励,
            [class*="claim"], [class*="reward"], button[onclick*="claim"]
        `).first();

        const isVisible = await claimButton.isVisible({ timeout: 30000 }).catch(() => false);

        if (isVisible) {
            console.log('🎁 找到按钮，点击领取...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1500 });

            await page.waitForTimeout(15000);

            const resultText = await page.locator('text=获得|成功|HN Points|HNRC|金币|奖励|+10').first().innerText().catch(() => '领取完成');
            status = `领取成功！ ${resultText}`;
        } else {
            const debugPath = `hnhost_debug_${Date.now()}.png`;
            await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
            console.log(`⚠️ 未找到领取按钮，已保存调试截图 → ${debugPath}`);

            status = '未找到领取奖励按钮（可能今日已领取 或 Token 登录失败）';
        }

        await sendTGReport(page, status);

    } catch (e) {
        console.log(`❌ 异常: ${e.message}`);
        status = `脚本异常: ${e.message}`;
        await sendTGReport(page, status);
        throw e;
    } finally {
        await browser.close();
    }
});
