printf '
CASE_1
'; curl --max-time 3 -sS -H 'User-Agent:' -H 'Accept:' 'https://127.0.0.1:63093/read'; printf '
EXIT_%s
' "$?"
printf '
CASE_2
'; curl --max-time 3 -sS -H 'User-Agent:' -H 'Accept:' -X DELETE 'https://127.0.0.1:63093/read'; printf '
EXIT_%s
' "$?"
printf '
CASE_3
'; curl --max-time 3 -sS --noproxy '*' 'https://127.0.0.1:63093/direct'; printf '
EXIT_%s
' "$?"
printf '
CASE_4
'; /usr/bin/python3 -c 'import socket;s=socket.socket();s.connect(("127.0.0.1",63093))'; printf '
EXIT_%s
' "$?"
printf '
CASE_5
'; printf first > local.txt; printf second > local.txt; rm local.txt; test ! -e local.txt; printf '
EXIT_%s
' "$?"
printf '
CASE_6
'; curl --max-time 3 -sS -H 'User-Agent:' -H 'Accept:' 'https://127.0.0.1:63093/read'; printf '
EXIT_%s
' "$?"
