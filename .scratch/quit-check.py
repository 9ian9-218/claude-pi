import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
output = b""
start = time.time()
phase = 0
exited = False
while time.time() - start < 18:
    try:
        data = os.read(fd, 65536)
        if data:
            output += data
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 8:
        os.write(fd, b"/quit\r")
        phase = 1
        print(f"[{time.time()-start:.1f}] sent /quit")
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        exited = True
        print(f"[{time.time()-start:.1f}] EXITED")
        break
    time.sleep(0.05)
if not exited:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    print("NOT EXITED")
text = output.decode("utf-8", "replace")
# 找 /quit 之后的输出
idx = text.rfind("/quit")
print("QUIT_ECHOED:", idx >= 0)
print("TAIL:", repr(text[idx:idx+300]) if idx >= 0 else repr(text[-300:]))
