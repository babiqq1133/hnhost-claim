console.log('🔄 返回主仪表盘...');
        await page.goto('https://client.hnhost.net/', { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(8000);  // 额外等待欢迎语和用户信息加载

        // 获取当前金币 + 用户名（帮助确认页面加载程度）
        const currentGold = await page.locator('text=HN POINTS, text=HNRC, text=金币').locator('..').innerText().catch(() => '未知');
        const welcomeText = await page.locator('text=歡迎, text=欢迎').innerText().catch(() => '未知');
        console.log(`💰 当前金币: ${currentGold}`);
        console.log(`👤 欢迎信息: ${welcomeText}`);

        console.log('📜 多轮强制滚动 + 等待动态加载...');
        for (let i = 0; i < 15; i++) {   // 大幅增加次数
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
                // 尝试滚动所有可滚动容器
                document.querySelectorAll('div, section, main').forEach(el => {
                    if (el.scrollHeight > el.clientHeight) {
                        el.scrollTop = el.scrollHeight;
                    }
                });
            });
            await page.waitForTimeout(4000);
        }

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(5000);

        console.log('🪙 检测领取奖励按钮状态...');

        // 终极 JS 查找 + 点击
        const clicked = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            const buttons = document.querySelectorAll('button, [role="button"], .btn');
            for (let btn of buttons) {
                const text = (btn.innerText || btn.textContent || '').trim();
                if (text.includes('领取奖励') || text.includes('领取每日') || text.includes('领取')) {
                    console.log('✅ 找到按钮文字：', text);
                    btn.scrollIntoView({ block: 'center' });
                    setTimeout(() => btn.click(), 800);
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            console.log('🖱️ 已点击「领取奖励」按钮...');
            await page.waitForTimeout(12000);

            const newGold = await page.locator('text=HN POINTS, text=HNRC').locator('..').innerText().catch(() => '未知');
            console.log(`🏆 最新金币: ${newGold}`);

            status = '领取成功！ +10 HNRC';
            console.log(`🎉 ${status}`);
            await page.screenshot({ path: `hnhost_claim_success_${Date.now()}.png`, fullPage: true });
        } else {
            await page.screenshot({ path: `hnhost_debug_${Date.now()}.png`, fullPage: true });
            console.log('💾 已保存调试截图');

            const bottomText = await page.evaluate(() => document.body.innerText.slice(-5000)).catch(() => '无法获取');
            console.log('页面底部部分内容：\n', bottomText);

            status = '未找到领取奖励按钮（可能今日已领取或页面未完全加载）';
            console.log('❌ ' + status);
        }
