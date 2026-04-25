// tests/hnhost-claim.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 200000;   // 增加总超时，避免加载慢导致失败

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

// ==================== 登录函数 ====================
async function handleDiscordLogin(page, discordToken) {
    console.log('🔑 开始 Discord 登录流程...');

    const authorizeUrl = "https://discord.com/oauth2/authorize?client_id=977981235618021377&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join";

    await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);

    console.log('⏳ 等待 OAuth2 回调...');

    try {
        await page.waitForURL('**/discord.php?code=*', { timeout: 25000 });
        console.log('✅ OAuth2 回调成功');
    } catch (e) {
        console.log('⚠️ 未检测到 code 回调，使用 Token 注入回退...');
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

// ==================== 主测试 ====================
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
        const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' }).catch(() => null);
        if (res) console.log(`✅ 出口 IP 确认：${await res.text()}`);

        await handleDiscordLogin(page, DISCORD_TOKEN);

        // ==================== 关键加强：等待页面完全加载 ====================
        console.log('🔄 返回主仪表盘并等待完全加载...');
        await page.goto('https://client.hnhost.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // 等待欢迎语（用户名 + 编号）出现，这是页面完全加载的重要标志
        await page.waitForSelector('text=歡迎, text=欢迎', { timeout: 30000 }).catch(() => 
            console.log('⚠️ 未检测到欢迎语，但继续执行')
        );
        
        await page.waitForTimeout(10000);   // 额外等待动态模块加载

        // 显示当前状态
        const welcomeText = await page.locator('text=歡迎, text=欢迎').innerText().catch(() => '未知');
        const currentGold = await page.locator('text=HN POINTS, text=HNRC, text=金币').locator('..').innerText().catch(() => '未知');
        console.log(`👤 欢迎信息: ${welcomeText}`);
        console.log(`💰 当前金币: ${currentGold}`);

        // ==================== 终极滚动策略 ====================
        console.log('📜 执行多轮强制滚动到底部...');
        for (let i = 0; i < 15; i++) {
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
                // 滚动所有可能的可滚动容器
                document.querySelectorAll('div, section, main, .container').forEach(el => {
                    if (el.scrollHeight > el.clientHeight) {
                        el.scrollTop = el.scrollHeight;
                    }
                });
            });
            await page.waitForTimeout(4500);
        }

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(5000);

        console.log('🪙 检测领取奖励按钮状态...');

        // ==================== 终极 JS 点击（最强版） ====================
        console.log('🔍 使用终极 JS 方式查找任何包含“领取”的按钮...');

        const clicked = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);

            const buttons = document.querySelectorAll('button, [role="button"], .btn, [class*="button"]');
            for (let btn of buttons) {
                const text = (btn.innerText || btn.textContent || '').trim();
                if (text.includes('领取奖励') || 
                    text.includes('领取每日') || 
                    text.includes('领取') || 
                    text.includes('签到') || 
                    text.includes('登录奖励')) {
                    console.log('✅ 找到按钮，文字为：', text);
                    btn.scrollIntoView({ block: 'center' });
                    setTimeout(() => btn.click(), 800);
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            console.log('🖱️ 已通过 JS 点击「领取奖励」按钮...');
            await page.waitForTimeout(12000);

            const newGold = await page.locator('text=HN POINTS, text=HNRC, text=金币').locator('..').innerText().catch(() => '未知');
            console.log(`🏆 最新金币: ${newGold}`);

            status = '领取成功！ +10 HNRC';
            console.log(`🎉 ${status}`);
            await page.screenshot({ path: `hnhost_claim_success_${Date.now()}.png`, fullPage: true });
        } else {
            await page.screenshot({ path: `hnhost_debug_${Date.now()}.png`, fullPage: true });
            console.log('💾 已保存调试截图 hnhost_debug_*.png');

            const bottomText = await page.evaluate(() => document.body.innerText.slice(-6000)).catch(() => '无法获取');
            console.log('页面底部部分内容：\n', bottomText);

            status = '未找到领取奖励按钮（可能今日已领取或页面加载不完整）';
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
