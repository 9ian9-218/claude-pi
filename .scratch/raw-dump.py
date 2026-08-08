import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
chunks = []  # (time, data)
start = time.time()
phase = 0
while time.time() - start < 16:
    try:
        data = os.read(fd, 65536)
        if data:
            chunks.append((round(time.time()-start, 1), data))
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 7:
        os.write(fd, b"hi\r")
        phase = 1
    if phase == 1 and time.time() - start > 11:
        os.write(fd, b"abc")
        phase = 2
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        break
    time.sleep(0.05)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
# 找 "abc" 出现
for t, d in chunks:
    if t >= 10.5:
        if b"abc" in d:
            print(f"[{t}s] HAS abc in {len(d)} bytes")
        else:
            print(f"[{t}s] {len(d)} bytes, no abc:", repr(d[:80]))
