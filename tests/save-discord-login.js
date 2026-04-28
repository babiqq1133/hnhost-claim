// tests/save-discord-login.js
const { chromium } = require('@playwright/test');
const fs = require('fs');

async function saveLoginState() {
    console.log('🚀 正在启动浏览器，请手动完成 Discord 登录...');

    const browser = await chromium.launch({ 
        headless: false,     // 必须打开界面
        args: ['--no-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    const authUrl = `https://discord.com/oauth2/authorize?client_id=1497635385562628296&redirect_uri=https%3A%2F%2Fclient.hnhost.net%2Fbackend%2Fpdo%2Fdiscord.php&response_type=code&scope=identify+email+guilds+guilds.join`;

    console.log('🌐 打开 Discord 授权页面...');
    await page.goto(authUrl, { waitUntil: 'domcontentloaded' });

    console.log('\n=== 请在弹出的浏览器窗口中手动操作 ===');
    console.log('1. 使用你的 Discord 账号登录');
    console.log('2. 点击「授权」按钮');
    console.log('3. 等待页面跳转到 client.hnhost.net\n');

    await page.waitForURL('**/client.hnhost.net/**', { timeout: 300000 })
        .then(() => console.log('✅ 登录成功！正在保存状态...'))
        .catch(() => console.log('⚠️ 超时，请确保已完成授权'));

    const storageState = await context.storageState();
    fs.writeFileSync('storageState.json', JSON.stringify(storageState, null, 2));

    console.log('🎉 storageState.json 保存成功！');
    console.log('请把这个文件上传到你的 GitHub 仓库。');

    await browser.close();
}

saveLoginState().catch(console.error);
