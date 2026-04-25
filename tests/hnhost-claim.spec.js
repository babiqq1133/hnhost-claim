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

// TG 推送（简化版，保持你的风格）
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

// === 你原来的 Token 注入方式（已适配 HnHost）===
async function handleDiscordLoginWithToken(page, token) {
    const DIRECT_AUTH_URL = "https://discord.com/login?redirect_to=%2Foauth2%2Fauthorize%3Fscope%3Dguilds%2Bguilds.join%2Bidentify%2Bemail%26client_id%3D933437142254887052%26redirect_uri%3Dhttps%253A%252F%252Fclient.hnhost.net%252Flogin%26response_type%3Dcode%26prompt%3Dnone";

    console.log('[*] 正在通过直达链接执行 Token 强制同步注入...');
    await page.goto(DIRECT_AUTH_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForTimeout(8000);

    await page.evaluate((t) => {
        const injector = (tokenStr) => {
            const timer = setInterval(() => {
                try {
                    document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage.token = `"${tokenStr}"`;
                } catch(e) {}
            }, 50);
            setTimeout(() => {
                clearInterval(timer);
                location.reload();
            }, 3000);
        };
        injector(t);
    }, t);

    await page.waitForTimeout(15000);
}

// 处理 OAuth 授权页（保留你的原函数）
async function handleOAuthPage(page) {
    await page.waitForTimeout(2000);

    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;

        try {
            const btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 3000 });
            const text = (await btn.innerText()).trim();

            if (/scroll/i.test(text) || text.includes('滚动')) {
                await page.evaluate(() => {
                    const s = document.querySelector('[class*="scroller"]') || document.querySelector('[class*="content"]');
                    if (s) s.scrollTop = s.scrollHeight;
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await page.waitForTimeout(1500);
                await btn.click();
                await page.waitForTimeout(1500);
            } else if (/authorize/i.test(text) || text.includes('授权')) {
                await btn.click();
                await page.waitForTimeout(3000);
                return;
            } else {
                await page.waitForTimeout(1500);
            }
        } catch {
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com'), { timeout: 10000 });
            } catch {}
            return;
        }
    }
}

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
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const ip = await res.text();
            console.log(`✅ 出口 IP 确认：${ip.trim()}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        // === Token 登录部分（使用你原来的方式）===
        await handleDiscordLoginWithToken(page, DISCORD_TOKEN);

        console.log('⏳ 等待 OAuth 授权页...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 20000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await handleOAuthPage(page);
        } catch (e) {
            console.log('ℹ️ 未检测到授权页或已自动跳转');
        }

        console.log('🌐 跳转到领取页面...');
        await page.goto('https://client.hnhost.net/index.php?server_event=renew_fail&pt=pterodactyl', { waitUntil: 'networkidle', timeout: 60000 });

        await page.waitForTimeout(6000);

        console.log('🪙 检测领取奖励按钮...');

        const claimButton = page.locator('button:has-text("领取奖励"), text=领取奖励').first();

        if (await claimButton.isVisible({ timeout: 15000 }).catch(() => false)) {
            console.log('🎁 点击领取奖励按钮...');
            await claimButton.scrollIntoViewIfNeeded();
            await claimButton.click({ delay: 1000 });
            await page.waitForTimeout(10000);

            points = await page.locator('text=获得|成功|HNRC').first().innerText().catch(() => '+10 HNRC');
            status = `领取成功！${points}`;
        } else {
            status = '未找到领取奖励按钮（可能今日已领取）';
        }

        await sendTGReport(page, status, points);

    } catch (e) {
        console.log(`❌ 异常: ${e.message}`);
        await sendTGReport(page, `脚本异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
