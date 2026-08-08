import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
chunks = []
start = time.time()
phase = 0
while time.time() - start < 20:
    try:
        data = os.read(fd, 65536)
        if data:
            chunks.append((round(time.time()-start, 1), len(data)))
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 6:
        os.write(fd, b"a")
        phase = 1
        print(f"[{time.time()-start:.1f}] sent 'a' (typing, no enter)")
    if phase == 1 and time.time() - start > 9:
        os.write(fd, b"b")
        phase = 2
        print(f"[{time.time()-start:.1f}] sent 'b'")
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        break
    time.sleep(0.05)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
print("--- 输出时间线 ---")
for t, n in chunks:
    if t >= 3:
        print(f"[{t:5.1f}] +{n}")
