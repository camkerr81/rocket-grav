import pexpect
import re
import sys
import time

def main():
    try:
        child = pexpect.spawn('agy', encoding='utf-8', dimensions=(50, 150))
        time.sleep(1)
        child.sendline('/quota')
        child.expect(r'Weekly Limit', timeout=15)
        time.sleep(2)
        
        try:
            screen = child.before + child.after + child.read_nonblocking(size=10000, timeout=2)
        except pexpect.TIMEOUT:
            screen = child.before + child.after
        
        match = re.search(r'\[[█░]+\]\s*([\d\.]+)%', screen)
        if match:
            percent = float(match.group(1))
            print(f"Weekly Limit: {percent}%")
            
            # Look for Refreshes in ...
            refresh_match = re.search(r'Refreshes in ([\dh m]+)', screen)
            if refresh_match:
                print(f"Refreshes in: {refresh_match.group(1)}")
                
            sys.exit(0)
        else:
            print("Could not find progress bar in output.")
            print("Screen dump:")
            print(screen)
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
