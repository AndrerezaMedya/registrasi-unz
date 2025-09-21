# D:\web\registrasi-unz\generate_qr.py
import csv, os, hmac, hashlib, base64
import qrcode
from PIL import Image

POOL_CSV = r"D:\web\registrasi-unz\code_pool.csv"
OUT_DIR = r"D:\web\registrasi-unz\qrs"
LOGO_PATH = r"D:\web\\registrasi-unz\assets\mid.png"
BASE_URL = "https://registrasi-unz.web.app/t"
HMAC_SECRET = b"ganti-dengan-secret-acak-min-32byte"  # simpan rahasia ini aman

def make_sig(code: str) -> str:
    digest = hmac.new(HMAC_SECRET, code.encode(), hashlib.sha256).digest()
    short = digest[:6]  # 6 bytes
    # base32 tanpa padding, uppercase, aman untuk URL
    return base64.b32encode(short).decode().rstrip("=")

def make_qr_img(data_url: str, logo_path: str):
    # QR high correction → logo tetap kebaca
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=4)
    qr.add_data(data_url)
    qr.make(fit=True)
    # Ubah fill_color menjadi #435258
    img = qr.make_image(fill_color="#435258", back_color="white").convert("RGBA")

    # overlay logo 256x256 center (di-scale relatif QR)
    if os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        qw, qh = img.size
        # logo sekitar 19% lebar QR
        target = int(qw * 0.19)
        logo.thumbnail((target, target), Image.LANCZOS)
        lw, lh = logo.size
        pos = ((qw - lw)//2, (qh - lh)//2)
        img.paste(logo, pos, logo)
    return img

os.makedirs(OUT_DIR, exist_ok=True)
with open(POOL_CSV, newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    for row in r:
        code = row["code"].strip().upper()
        # tambahkan signature opsional
        sig = make_sig(code)
        url = f"{BASE_URL}?p={code}&s={sig}"
        img = make_qr_img(url, LOGO_PATH)
        out_path = os.path.join(OUT_DIR, f"{code}.png")
        img.save(out_path)
        print("Saved", out_path)