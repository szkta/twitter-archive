import json
import os
import time
import glob
import requests
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from datetime import datetime

# ==============================================================
# 設定・概要
# 同じフォルダにある `_tweets_raw.json` (JSで保存したファイル) を探し、
# 画像をダウンロードして、閲覧用ビューワー向けの形式に変換・統合します。
# ==============================================================

def get_extension_from_url(url):
    """URL文字列からファイルの拡張子(.jpg, .png等)を推測する関数"""
    try:
        parsed = urlparse(url)
        path_ext = os.path.splitext(parsed.path)[1]
        if path_ext: return path_ext
        query = parse_qs(parsed.query)
        if 'format' in query: return f".{query['format'][0]}"
    except:
        pass
    return ".jpg"

def convert_to_orig_url(url):
    """画像のURLを最高画質(orig)のURLに変換する関数"""
    if ".mp4" in url: return url
    if "twimg.com" not in url: return url
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if 'format' in query:
            query['name'] = ['orig']
            new_query = urlencode(query, doseq=True)
            return urlunparse(parsed._replace(query=new_query))
    except:
        pass
    return url

def download_file(url, save_dir, tweet_id, index):
    """指定されたURLの画像・動画をダウンロードし、ローカルに保存する関数"""
    if not url: return None
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://x.com/"
    }

    try:
        orig_url = convert_to_orig_url(url)
        ext = get_extension_from_url(orig_url)
        filename = f"{tweet_id}_{index}{ext}"
        save_path = os.path.join(save_dir, filename)
        
        if os.path.exists(save_path) and os.path.getsize(save_path) > 0:
            return save_path

        response = requests.get(orig_url, headers=headers, stream=True, timeout=20)
        
        if response.status_code != 200 and ".mp4" not in url:
            if url != orig_url:
                response = requests.get(url, headers=headers, stream=True, timeout=20)
            
            if response.status_code != 200:
                parsed = urlparse(url)
                query = parse_qs(parsed.query)
                if 'format' in query:
                    retry_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}.{query['format'][0]}"
                    response = requests.get(retry_url, headers=headers, stream=True, timeout=20)

        if response.status_code == 200:
            with open(save_path, 'wb') as f:
                for chunk in response.iter_content(1024):
                    f.write(chunk)
            time.sleep(0.1) 
            return save_path
        
    except Exception as e:
        print(f"   [Error] DL失敗: {e}")
    return None

def merge_posts(existing_posts, new_posts):
    """既存の投稿リストと新しい投稿リストをマージする関数"""
    post_map = {p["id"]: p for p in existing_posts if "id" in p}
    new_count = 0
    
    for p in new_posts:
        if p["id"] not in post_map:
            post_map[p["id"]] = p
            new_count += 1
        else:
            post_map[p["id"]].update(p)

    merged_list = list(post_map.values())
    
    def parse_date(date_str):
        if not date_str: return datetime.min
        try: return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except: return datetime.min

    merged_list.sort(key=lambda x: parse_date(x.get("date")), reverse=True)
    return merged_list, new_count

def update_profile_history(existing_meta, new_info, image_dir):
    """
    プロフィールの変遷を管理する関数。
    戻り値: (historyリスト, 変更があったかどうかのBool値)
    """
    history = existing_meta.get("profile_history", [])
    
    profile_img_dir = os.path.join(image_dir, "profile")
    if not os.path.exists(profile_img_dir):
        os.makedirs(profile_img_dir)
        
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    local_avatar = download_file(new_info.get("avatarUrl"), profile_img_dir, f"icon_{timestamp_str}", "")
    
    current_entry = {
        "date": datetime.now().isoformat(),
        "name": new_info.get("name", ""),
        "screen_name": new_info.get("screenName", ""),
        "avatar": local_avatar or "",
        "following": str(new_info.get("following", "0")), # 文字列として統一
        "followers": str(new_info.get("followers", "0"))  # 文字列として統一
    }

    if not history:
        history.append(current_entry)
        print("   >>> プロフィール情報を記録しました。")
        return history, True # 新規作成なので変更あり

    last_entry = history[0]
    
    # 1. 重要な変更（名前やID）→ 履歴に追加
    is_structural_change = (last_entry["name"] != current_entry["name"]) or \
                           (last_entry["screen_name"] != current_entry["screen_name"])
    
    if is_structural_change:
        history.insert(0, current_entry)
        print("   >>> プロフィール変更を検知！履歴に追加しました。")
        return history, True # 変更あり

    # 2. 数値やアイコンの変更 → 最新の履歴を更新
    # 比較のために既存データも文字列化しておく
    last_following = str(last_entry.get("following", "0"))
    last_followers = str(last_entry.get("followers", "0"))
    last_avatar = last_entry.get("avatar", "")

    is_stat_changed = (last_following != current_entry["following"]) or \
                      (last_followers != current_entry["followers"]) or \
                      (last_avatar != current_entry["avatar"])

    if is_stat_changed:
        history[0].update(current_entry)
        # 数値が変わっただけでも「変更あり」とする
        return history, True 
    
    # 変更なし
    return history, False

def process_file(input_file):
    print(f"\n>>> 入力ファイルを処理中: {input_file}")
    
    try:
        with open(input_file, "r", encoding="utf-8") as f:
            raw_data = json.load(f)
    except Exception as e:
        print(f"エラー: JSON読み込み失敗 ({e})")
        return

    # メタデータ取得
    target_user = raw_data.get("meta", {}).get("target", "unknown")
    user_info = raw_data.get("meta", {}).get("user_info", {})
    
    output_file = f"{target_user}_data.json"
    image_dir = f"{target_user}_images"

    if not os.path.exists(image_dir):
        os.makedirs(image_dir)

    # --- 既存データ読み込み ---
    existing_meta = {}
    existing_posts = []
    if os.path.exists(output_file):
        try:
            with open(output_file, "r", encoding="utf-8") as f:
                d = json.load(f)
                existing_meta = d.get("meta", {})
                existing_posts = d.get("posts", [])
        except: pass

    # --- プロフィール履歴の更新 (変更有無を取得) ---
    profile_history, profile_changed = update_profile_history(existing_meta, user_info, image_dir)

    # --- ポストのマージ ---
    merged_posts, new_count = merge_posts(existing_posts, raw_data.get("posts", []))
    print(f"   ポスト追加: {new_count}件 / 総数: {len(merged_posts)}件")

    # --- 更新日時の決定 ---
    # 新しいポストがある OR プロフィールに変更がある OR 初回作成 の場合のみ現在時刻に更新
    previous_updated = existing_meta.get("last_updated")
    
    if new_count > 0 or profile_changed or not previous_updated:
        last_updated_date = datetime.now().isoformat()
        update_status = "更新"
    else:
        last_updated_date = previous_updated
        update_status = "維持"
    
    print(f"   データ更新日時: {update_status} ({last_updated_date})")

    # --- 画像ダウンロード ---
    success_dl = 0
    for i, post in enumerate(merged_posts):
        tweet_id = post.get("id", "unknown")
        image_urls = post.get("images", [])
        local_images = []
        
        needs_dl = any(url.startswith("http") for url in image_urls)
        
        if not needs_dl:
            continue

        if image_urls:
            if i % 50 == 0: print(f"   メディアDL進行中... {i}/{len(merged_posts)}")
            
            for idx, url in enumerate(image_urls):
                if not url.startswith("http"):
                    local_images.append(url)
                    continue
                
                local_path = download_file(url, image_dir, tweet_id, idx)
                if local_path:
                    local_images.append(local_path)
                    success_dl += 1
            
            post["images"] = local_images

    # --- 保存 ---
    output_data = {
        "meta": {
            "target_user": target_user,
            "last_updated": last_updated_date, # 計算した日時を使用
            "total_posts_retrieved": len(merged_posts),
            "profile_history": profile_history,
            "user_info": user_info
        },
        "posts": merged_posts
    }

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=4, ensure_ascii=False)
    
    print(f"   完了: {output_file} (新規画像保存: {success_dl}枚)")

def main():
    raw_files = glob.glob("*_tweets_raw.json")
    if not raw_files:
        print("エラー: *_tweets_raw.json が見つかりません。")
        return
    for f in raw_files: process_file(f)
    print("\n" + "="*40 + "\n全処理完了\n" + "="*40)

if __name__ == "__main__":
    main()