"""
ARC FUKAMEKI minoh — さくらインターネット FTPデプロイスクリプト
変更ファイルをサーバーに同期する
"""
import ftplib, os, sys

FTP_HOST = "fukamekizakkaten.sakura.ne.jp"
FTP_USER = "fukamekizakkaten"
FTP_PASS = "kmyCn3=LnZHD"
REMOTE_DIR = "/home/fukamekizakkaten/www/fukameki.jp"
LOCAL_DIR  = os.path.dirname(os.path.abspath(__file__))

EXCLUDE = {
    # Git / CI
    '.git', '.github', '.claude', '__pycache__', 'node_modules',
    # 開発用スクリプト・設定
    'deploy.py', 'CLAUDE.md', 'fix_casca.py',
    'gen_casca.py', 'gen_products.py',
    'fukameki_deploy_key', 'fukameki_deploy_key.pub',
    # 開発フォルダ
    '_dev',
    # 元画像フォルダ（圧縮済みはphoto/indexにある）
    'AMPIANA', '0520',
    # 元データ（HEIC）
    '元データ',
}

def should_exclude(path):
    parts = path.replace('\\', '/').split('/')
    return any(p in EXCLUDE or p.startswith('.') for p in parts)

def ftp_mkdirs(ftp, path):
    parts = [p for p in path.split('/') if p]
    current = ''
    for part in parts:
        current += '/' + part
        try:
            ftp.mkd(current)
        except ftplib.error_perm:
            pass

def upload_file(ftp, local_path, remote_path):
    try:
        ftp_mkdirs(ftp, os.path.dirname(remote_path))
        with open(local_path, 'rb') as f:
            ftp.storbinary(f'STOR {remote_path}', f)
        return True
    except Exception as e:
        print(f"  ERR {remote_path}: {e}")
        return False

def main():
    print(f"接続中: {FTP_HOST}")
    ftp = ftplib.FTP()
    ftp.connect(FTP_HOST, 21, timeout=30)
    ftp.login(FTP_USER, FTP_PASS)
    ftp.set_pasv(True)
    print("接続OK\n")

    ok = err = 0
    for root, dirs, files in os.walk(LOCAL_DIR):
        rel_root = os.path.relpath(root, LOCAL_DIR).replace('\\', '/')
        if rel_root == '.':
            rel_root = ''

        # 除外ディレクトリをスキップ
        dirs[:] = [d for d in dirs if d not in EXCLUDE and not d.startswith('.')]

        for fname in files:
            rel_path = (rel_root + '/' + fname).lstrip('/')
            if should_exclude(rel_path):
                continue

            local_path  = os.path.join(root, fname)
            remote_path = REMOTE_DIR + '/' + rel_path

            if upload_file(ftp, local_path, remote_path):
                print(f"  OK  {rel_path}")
                ok += 1
            else:
                err += 1

    ftp.quit()
    print(f"\n完了: {ok}件アップロード / {err}件エラー")

if __name__ == '__main__':
    main()
