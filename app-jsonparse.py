import json
import os
import time
import glob
import requests
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from datetime import datetime

def get_extension_from_url(url):
    try:
        parsed = urlparse(url)
        path_ext = os.path.splitext(parsed.path)[1]
        if path_ext: return path_ext
        query = parse_qs(parsed.query)
        if 'format' in query: return f".{query['format'][0]}"
    except: pass
    return ".jpg"

def convert_to_orig_url(url):
    """画像はorigに、動画(mp4)はそのまま返す"""
    if ".mp4" in url: return url # 動画は加工しない
    if "twimg.com" not in url: return url
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if 'format' in query:
            query['name'] = ['orig']
            new_query = urlencode(query, doseq=True)
            return urlunparse(parsed._replace(query=new_query))
    except: pass
    return url

def download_file(url, save_dir, tweet_id, index):
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
        
        # 404リトライ（画像のみ）
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
    post_map = {p["id"]: p for p in existing_posts if "id" in p}
    new_count = 0
    for p in new_posts:
        if p["id"] not in post_map:
            post_map[p["id"]] = p
            new_count += 1
        else:
            # 既存のデータに投票データがない場合などは更新する
            post_map[p["id"]].update(p)

    merged_list = list(post_map.values())
    def parse_date(date_str):
        if not date_str: return datetime.min
        try: return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except: return datetime.min

    merged_list.sort(key=lambda x: parse_date(x.get("date")), reverse=True)
    return merged_list, new_count

def update_profile_history(existing_meta, new_info, image_dir):
    history = existing_meta.get("profile_history", [])
    profile_img_dir = os.path.join(image_dir, "profile")
    if not os.path.exists(profile_img_dir): os.makedirs(profile_img_dir)
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    local_avatar = download_file(new_info.get("avatarUrl"), profile_img_dir, f"icon_{timestamp_str}", "")
    
    current_entry = {
        "date": datetime.now().isoformat(),
        "name": new_info.get("name", ""),
        "screen_name": new_info.get("screenName", ""),
        "avatar": local_avatar or ""
    }

    if not history:
        history.append(current_entry)
        print("   >>> プロフィール情報を記録しました。")
    else:
        last_entry = history[0]
        is_changed = (last_entry["name"] != current_entry["name"]) or \
                     (last_entry["screen_name"] != current_entry["screen_name"])
        if is_changed:
            history.insert(0, current_entry)
            print("   >>> プロフィール変更を検知！履歴に追加しました。")
        else:
            history[0].update(current_entry)
    return history

def process_file(input_file):
    print(f"\n>>> 入力ファイルを処理中: {input_file}")
    try:
        with open(input_file, "r", encoding="utf-8") as f:
            raw_data = json.load(f)
    except Exception as e:
        print(f"エラー: JSON読み込み失敗 ({e})")
        return

    target_user = raw_data.get("meta", {}).get("target", "unknown")
    user_info = raw_data.get("meta", {}).get("user_info", {})
    output_file = f"{target_user}_data.json"
    image_dir = f"{target_user}_images"

    if not os.path.exists(image_dir): os.makedirs(image_dir)

    existing_meta = {}
    existing_posts = []
    if os.path.exists(output_file):
        try:
            with open(output_file, "r", encoding="utf-8") as f:
                d = json.load(f)
                existing_meta = d.get("meta", {})
                existing_posts = d.get("posts", [])
        except: pass

    profile_history = update_profile_history(existing_meta, user_info, image_dir)
    merged_posts, new_count = merge_posts(existing_posts, raw_data.get("posts", []))
    print(f"   ポスト追加: {new_count}件 / 総数: {len(merged_posts)}件")

    for i, post in enumerate(merged_posts):
        tweet_id = post.get("id", "unknown")
        image_urls = post.get("images", [])
        local_images = []
        
        needs_dl = any(url.startswith("http") for url in image_urls)
        
        if needs_dl:
            if i % 50 == 0: print(f"   メディアDL進行中... {i}/{len(merged_posts)}")
            for idx, url in enumerate(image_urls):
                if not url.startswith("http"):
                    local_images.append(url)
                    continue
                # 動画(mp4)か画像(jpg/png)かを判別してダウンロード
                local_path = download_file(url, image_dir, tweet_id, idx)
                if local_path: local_images.append(local_path)
            post["images"] = local_images

    output_data = {
        "meta": {
            "target_user": target_user,
            "last_updated": datetime.now().isoformat(),
            "total_posts_retrieved": len(merged_posts),
            "profile_history": profile_history
        },
        "posts": merged_posts
    }

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=4, ensure_ascii=False)
    print(f"   完了: {output_file}")

def main():
    raw_files = glob.glob("*_tweets_raw.json")
    if not raw_files:
        print("エラー: *_tweets_raw.json が見つかりません。")
        return
    for f in raw_files: process_file(f)
    print("\n" + "="*40 + "\n全処理完了\n" + "="*40)

if __name__ == "__main__":
    main()