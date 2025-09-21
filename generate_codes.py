# D:\web\registrasi-unz\generate_codes.py
import random, string, csv, os, re

OUT_CSV = r"D:\web\registrasi-unz\code_pool.csv"
COUNT = 2000

digits = "123456789"
letters = string.ascii_uppercase  # A-Z

def is_easy(code: str) -> bool:
	# code = N X N X N (len=5)
	d1, x1, d2, x2, d3 = code[0], code[1], code[2], code[3], code[4]
	# 1) semua digit sama?
	if d1 == d2 == d3:
		return True
	# 2) huruf sama?
	if x1 == x2:
		return True
	# 3) digit naik/turun berurutan (jarak 1)
	di = list(map(int, [d1, d2, d3]))
	if di[1] - di[0] == 1 and di[2] - di[1] == 1:  # naik: 1,2,3
		return True
	if di[0] - di[1] == 1 and di[1] - di[2] == 1:  # turun: 3,2,1
		return True
	# 4) pola spesifik super-gampang (opsional): 1A1A1, 2B2B2, dst.
	if d1 == d3 == d3 and x1 == x2:
		return True
	return False

def gen_code():
	return random.choice(digits) + random.choice(letters) + \
	       random.choice(digits) + random.choice(letters) + \
	       random.choice(digits)

def build_pool(n=COUNT):
	seen = set()
	out = []
	while len(out) < n:
		c = gen_code()
		if c in seen:
			continue
		if is_easy(c):
			continue
		seen.add(c)
		out.append(c)
	return out

os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
pool = build_pool(COUNT)
with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
	writer = csv.writer(f)
	writer.writerow(["code","status","assigned_to_email","assigned_at"])
	for c in pool:
		writer.writerow([c,"free","",""])
print(f"Saved {OUT_CSV} with {len(pool)} codes.")
