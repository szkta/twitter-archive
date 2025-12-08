(async function() {
    // --- 設定 ---
    const SCROLL_DELAY = 3000;
    // ------------

    // 1. URLからターゲットIDを特定
    let TARGET_ID = "";
    const pathParts = window.location.pathname.split('/');
    
    if (pathParts[1] === "search") {
        const urlParams = new URLSearchParams(window.location.search);
        const query = urlParams.get('q');
        if (query) {
            const match = query.match(/from:([a-zA-Z0-9_]+)/i);
            if (match) TARGET_ID = match[1];
        }
        if (!TARGET_ID) {
            const searchInput = document.querySelector('input[data-testid="SearchBox_Search_Input"]');
            if (searchInput && searchInput.value.includes('from:')) {
                 const match = searchInput.value.match(/from:@([a-zA-Z0-9_]+)/i);
                 if (match) TARGET_ID = match[1];
            }
        }
    } else {
        TARGET_ID = pathParts[1];
    }

    if (!TARGET_ID) {
        console.error("エラー：ユーザーIDが特定できませんでした。");
        return;
    }

    console.log(`>>> @${TARGET_ID} の収集を開始します...`);

    // プロフィール情報の器（最初は空で作成し、ツイートから取得して埋める）
    const profileData = {
        name: TARGET_ID,       // 仮置き
        screenName: "@" + TARGET_ID, // 仮置き
        avatarUrl: ""
    };
    let isProfileFilled = false; // プロフィール取得済みフラグ

    const collectedTweets = new Map();
    let lastHeight = 0;
    let noChangeCount = 0;

    // 投票データの解析
    function getPollData(article) {
        try {
            const pollRoot = article.querySelector('[data-testid="cardPoll"]');
            if (!pollRoot) return null;

            const options = [];
            const listItems = pollRoot.querySelectorAll('li[role="listitem"]');
            if (listItems.length === 0) return null;

            listItems.forEach(li => {
                const lines = li.innerText.split('\n').filter(line => line.trim() !== "");
                let percent = 0;
                let label = "";
                const percentIndex = lines.findIndex(line => /^\d+(\.\d+)?%$/.test(line));

                if (percentIndex !== -1) {
                    percent = parseFloat(lines[percentIndex].replace('%', ''));
                    label = lines.slice(0, percentIndex).join(" ");
                } else {
                    label = lines[0];
                }
                options.push({ label: label, percent: percent });
            });

            let totalVotes = 0;
            const footerText = pollRoot.innerText;
            const voteMatch = footerText.match(/([\d,]+)\s*(票|votes)/);
            if (voteMatch) {
                totalVotes = parseInt(voteMatch[1].replace(/,/g, ''), 10);
            }

            if (options.length > 0) {
                return { options: options, total_votes: totalVotes };
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    function getTweetData(article) {
        try {
            // ユーザー特定とリポスト判定
            const userLinks = article.querySelectorAll('div[data-testid="User-Name"] a');
            if (userLinks.length === 0) return null;

            let isTargetUser = false;
            
            // リンクの中からターゲットIDを含むものを探す
            for (const link of userLinks) {
                const href = link.getAttribute('href');
                if (href && href.toLowerCase().endsWith(`/${TARGET_ID.toLowerCase()}`)) {
                    isTargetUser = true;
                    break;
                }
            }

            // ターゲットユーザーのツイートでない場合はスキップ
            // (検索画面などで他人のツイートが混ざるのを防ぐ)
            if (!isTargetUser) return null;

            // --- プロフィール情報の補完（ツイートから取得） ---
            if (!isProfileFilled) {
                try {
                    // 名前とスクリーンネームの取得
                    // User-Nameエリア内のテキストを走査
                    const userNameDiv = article.querySelector('div[data-testid="User-Name"]');
                    if (userNameDiv) {
                        const textContent = userNameDiv.innerText.split('\n');
                        if (textContent.length >= 2) {
                            profileData.name = textContent[0]; // 1行目が表示名
                            profileData.screenName = textContent[1]; // 2行目が@ID
                        }
                    }

                    // アイコン画像の取得
                    const avatarImg = article.querySelector('div[data-testid="Tweet-User-Avatar"] img');
                    if (avatarImg) {
                        profileData.avatarUrl = avatarImg.src;
                    }

                    // 名前とアイコンが取れたらフラグを立てる（以降は処理しない）
                    if (profileData.name && profileData.avatarUrl) {
                        isProfileFilled = true;
                        console.log("プロフィール情報をツイートから取得しました:", profileData);
                    }
                } catch (e) {
                    console.warn("プロフィール取得試行中にエラー:", e);
                }
            }
            // ------------------------------------------------

            // テキスト
            const textEl = article.querySelector('div[data-testid="tweetText"]');
            let text = "";
            if (textEl) {
                const clone = textEl.cloneNode(true);
                clone.querySelectorAll('img').forEach(img => {
                    const alt = img.getAttribute('alt');
                    if (alt) img.replaceWith(document.createTextNode(alt));
                });
                text = clone.innerText;
            }

            // 日付・URL
            const timeEl = article.querySelector('time');
            if (!timeEl) return null;
            const date = timeEl.getAttribute('datetime');
            const tweetUrl = timeEl.closest('a').getAttribute('href');
            const id = tweetUrl.split('/').pop();

            // 画像・GIF
            const mediaFiles = [];
            article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach(img => {
                let src = img.src;
                if (src.includes('tweet_video_thumb')) {
                    const mp4Src = src.replace('pbs.twimg.com/tweet_video_thumb', 'video.twimg.com/tweet_video')
                                      .replace(/\.(jpg|png|webp).*/, '.mp4');
                    mediaFiles.push(mp4Src);
                } else {
                    mediaFiles.push(src);
                }
            });

            // 投票
            const poll = getPollData(article);

            const getMetric = (testId) => {
                const el = article.querySelector(`[data-testid="${testId}"]`);
                return el ? (el.ariaLabel || el.innerText || "0") : "0";
            };

            return {
                id: id,
                date: date,
                text: text,
                url: "https://x.com" + tweetUrl,
                images: mediaFiles,
                poll: poll,
                metrics: {
                    reply: getMetric("reply"),
                    repost: getMetric("retweet"),
                    like: getMetric("like")
                }
            };
        } catch (e) {
            return null;
        }
    }

    // スクロールループ
    while (true) {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => {
            const data = getTweetData(article);
            if (data && !collectedTweets.has(data.id)) {
                collectedTweets.set(data.id, data);
                let info = "";
                if (data.images.some(u => u.endsWith('.mp4'))) info += "[GIF] ";
                if (data.poll) info += "[投票] ";
                console.log(`取得: ${info}${data.text.substring(0, 15)}...`);
            }
        });

        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, SCROLL_DELAY));

        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
            noChangeCount++;
            if (noChangeCount >= 3) break; 
        } else {
            noChangeCount = 0;
            lastHeight = newHeight;
        }
    }

    const result = {
        meta: { 
            target: TARGET_ID, 
            exported_at: new Date().toISOString(),
            user_info: profileData 
        },
        posts: Array.from(collectedTweets.values())
    };
    
    const blob = new Blob([JSON.stringify(result, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${TARGET_ID}_tweets_raw.json`;
    link.click();
    console.log(`>>> 完了！ ${result.posts.length} 件のデータを保存しました。`);
})();
