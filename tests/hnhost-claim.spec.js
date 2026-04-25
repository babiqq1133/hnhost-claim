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

// ==================== 优化后的登录函数 ====================
async function handleDiscordLogin(page, discordToken) {
    console.log('🔑 开始 Discord 登录流程...');

    const authorizeUrl = "https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join";

    await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);

    console.log('⏳ 等待 OAuth2 回调...');

    // 等待回调（带 code 参数）
    try {
        await page.waitForURL('**/discord.php?code=*', { timeout: 25000 });
        console.log('✅ OAuth2 回调成功，拿到 code');
    } catch (e) {
        console.log('⚠️ 未检测到 code 回调，尝试 Token 注入回退...');
        await page.evaluate((t) => {
            try {
                if (typeof localStorage !== "undefined") localStorage.setItem("token", `"${t}"`);
                document.cookie = `token=${encodeURIComponent(t)}; path=/; max-age=3600`;
            } catch (err) {}
        }, discordToken);
        await page.reload({ waitUntil: 'networkidle' });
    }

    await page.waitForTimeout(5000);
    await page.goto('https://client.hnhost.net/', { waitUntil: 'networkidle', timeout: 60000 });
    
    console.log('✅ 登录 Session 建立完成');
}

// 主测试
test('HnHost 每日领取金币', async () => {
    test.setTimeout(TIMEOUT);
    if (!DISCORD_TOKEN) throw new Error('❌ 缺少 DISCORD_TOKEN 配置');

    const browser = await chromium.launch({
        headless: true,        // 调试时可改为 false
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

        await handleDiscordLogin(page, DISCORD_TOKEN);

        // 点击伺服器面板入口（如果需要）
        console.log('🔍 点击伺服器面板入口...');
        const panelLink = page.locator('text=伺服器面板').first();
        if (await panelLink.isVisible({ timeout: 10000 }).catch(() => false)) {
            await panelLink.click();
            await page.waitForTimeout(5000);
        }

        // 确保回到主仪表盘
        console.log('🔄 返回主仪表盘...');
        await page.goto('https://client.hnhost.net/', { waitUntil: 'networkidle' });

        // 显示当前金币（可选调试）
        const currentPoints = await page.locator('text=HN POINTS, text=HNRC').locator('..').innerText().catch(() => '未知');
        console.log(`💰 当前金币: ${currentPoints}`);

        // 多轮滚动到底部 + 等待
        console.log('📜 多轮滚动到底部，确保按钮出现...');
        for (let i = 0; i < 6; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(3000);
        }

        console.log('🪙 检测领取奖励按钮...');

        // 加强版按钮定位（适配你截图中的“领取奖励”）
        const claimButton = page.locator('button')
            .filter({ hasText: /领取奖励|领取每日签到奖励|签到奖励/i })
            .or(page.getByRole('button', { name: /领取奖励/i }))
            .or(page.getByText(/领取奖励/))
            .first();

        let buttonFound = false;
        try {
            await claimButton.waitFor({ state: 'visible', timeout: 20000 });
            buttonFound = await claimButton.count() > 0;
        } catch (e) {}

        if (buttonFound) {
            console.log('🎁 找到领取奖励按钮，点击...');
            await claimButton.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1500);
            await claimButton.click({ delay: 800 });

            await page.waitForTimeout(8000); // 等待页面刷新/提示出现

            // 检查成功提示
            const success = await page.locator('text=/获得|成功|HN Points|金币|\+10|领取成功/i').first().isVisible().catch(() => false);
            
            status = success ? '领取成功！ +10 HNRC' : '按钮已点击（未检测到明确成功提示）';
            console.log(`✅ ${status}`);

            // 保存结果截图
            await page.screenshot({ path: `hnhost_claim_success_${Date.now()}.png`, fullPage: true });
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
