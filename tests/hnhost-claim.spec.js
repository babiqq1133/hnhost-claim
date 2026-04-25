// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

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

// ====================== Token 注入（保持原逻辑，稍微优化） ======================
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
                if (typeof localStorage !== "undefined") {
                    localStorage.setItem("token", `"${t}"`);
                }
                if (typeof sessionStorage !== "undefined") {
                    sessionStorage.setItem("token", `"${t}"`);
                }
                window.token = t;
                window.discordToken = t;
                document.cookie = `token=${encodeURIComponent(t)}; path=/; max-age=3600`;
            } catch (err) {
                console.log("注入小错误:", err.message);
            }
        };

        injectToken();
        for (let i = 1; i <= 6; i++) {
            setTimeout(injectToken, i * 500);
        }
        setTimeout(() => location.reload(), 6000);
    }, token);

    await page.waitForTimeout(18000);
    console.log('✅ Token 注入阶段完成');
}

// ====================== 主测试 ======================
test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);

    if (!DISCORD_TOKEN) {
        throw new Error('❌ 缺少 DISCORD_TOKEN 配置');
    }

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
        } catch (e) {
            console.log('⚠️ IP 验证失败');
        }

        await handleDiscordLoginWithToken(page, DISCORD_TOKEN);

        // === 关键修复：尝试进入控制面板 ===
        console.log('🌐 跳转到 HnHost 控制面板...');
        
        const dashboardUrls = [
            'https://client.hnhost.net/dashboard',
            'https://client.hnhost.net/panel',
            'https://client.hnhost.net/',
        ];

        let entered = false;
        for (const url of dashboardUrls) {
            try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
                await page.waitForTimeout(8000);
                
                // 等待动态加载完成
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(5000);

                // 滚动到底部，确保“其他操作”区域加载
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(3000);

                entered = true;
                console.log(`✅ 已进入页面: ${url}`);
                break;
            } catch (e) {
                console.log(`⚠️ 跳转 ${url} 失败，尝试下一个...`);
            }
        }

        if (!entered) {
            throw new Error('无法进入控制面板');
        }

        // 如果有 Discord 登录按钮，点击
        const discordBtn = page.locator('button:has-text("Discord"), text=通过 Discord, text=登录').first();
        if (await discordBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('🔗 点击 Discord 登录按钮...');
            await discordBtn.click();
            await page.waitForTimeout(10000);
        }

        console.log('🪙 检测领取奖励按钮...');

        // 更可靠的选择器（推荐方式）
        const claimButton = page.getByRole('button', { name: /领取奖励/i })
            .or(page.locator('button:has-text("领取奖励")'))
            .or(page.locator('text=领取奖励'))
            .first();

        // 等待按钮出现（最多25秒）
        const isVisible = await claimButton.waitFor({ state: 'visible', timeout: 25000 })
            .then(() => true)
            .catch(() => false);

        if (isVisible) {
            console.log('🎁 找到领取奖励按钮，准备点击...');
            await claimButton.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1000);
            await claimButton.click({ delay: 800 });

            await page.waitForTimeout(8000);

            // 检查是否领取成功
            const successText = await page.locator('text=获得|成功|HN Points|金币|+10|领取成功')
                .first().innerText().catch(() => '领取完成');

            status = `领取成功！ ${successText}`;
            console.log(`✅ ${status}`);
        } else {
            await page.screenshot({ path: `hnhost_debug_${Date.now()}.png`, fullPage: true }).catch(() => {});
            status = '未找到领取奖励按钮（可能今日已领取 或 页面加载不完整）';
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
