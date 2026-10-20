# 티켓 예매 자동 클릭

Windows Chrome용 Manifest V3 확장 프로그램입니다. 지정한 버튼의 활성화를 감지하고 사용자가 놓은 마우스 위치에 CDP 눌림·놓임을 한 번 전송합니다. 현재 버전은 **2.2.20**입니다.

## 다운로드와 설치

1. [최신 ZIP 다운로드](https://github.com/bincan98/ticketing/releases/latest/download/ticket-click-extension.zip)
2. 고정된 폴더에 압축을 풉니다. 예: `C:\ticketing-extension`
3. Chrome에서 `chrome://extensions`를 열고 개발자 모드를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고 `manifest.json`이 있는 폴더를 선택합니다.

GitHub의 **Source code (zip)** 대신 Release에 첨부된 **ticket-click-extension.zip**을 받으세요. 배포 ZIP에는 실행 파일 10개만 들어갑니다. [전체 버전](https://github.com/bincan98/ticketing/releases)과 SHA256SUMS.txt에서 버전·무결성을 확인할 수 있습니다.

업데이트할 때는 감시를 정지하고 같은 폴더에 새 ZIP을 풀어 파일을 교체한 뒤, 확장 관리 화면의 새로고침과 대상 웹페이지 새로고침을 진행하세요. 확장을 삭제했다가 다시 설치할 필요는 없습니다. GitHub 배포는 Chrome의 자동 업데이트 방식이 아닙니다.

## 사용

- 사이트에 직접 로그인한 뒤 프로필을 선택합니다.
- **실제 클릭 시작**을 누르고 Popup을 닫은 뒤 클릭할 위치에 마우스를 놓습니다.
- 감시 버튼의 활성화/예약 조건이 충족되면 기록된 현재 위치를 한 번 누릅니다. 커서 아래 요소가 예매 버튼인지 검사하지 않습니다.
- 감시 제한은 버튼 단계당 2분입니다. 시작/정지, 버튼 교체 재탐색, 로그 확인·복사·다운로드를 지원합니다.
- 실제 입력은 CDP만 사용합니다. 연결 실패나 입력 오류가 나면 자동 재시도 또는 JavaScript 클릭 전환 없이 종료합니다.
- Chrome의 debugger 연결 안내가 표시될 수 있으며 개발자도구와 충돌할 수 있습니다. 로그인·CAPTCHA·대기열을 자동으로 우회하는 기능은 없습니다.

## 개발과 배포

Node.js 24를 사용합니다. Chrome 및 Windows 프로필 검증을 위해 CI는 Windows에서 실행됩니다.

```powershell
git clone https://github.com/bincan98/ticketing.git
cd ticketing
npm ci --ignore-scripts
npm test
npm run build
npm run package
```

의존성은 잠금 파일의 버전·무결성 값으로 설치합니다. ZIP 라이브러리는 개발/배포에만 사용하고 실행 ZIP에는 포함하지 않습니다. Chrome 통합 테스트를 별도로 실행하려면 `npx playwright install chromium` 후 `npm run test:chrome`, `npm run test:nol-countdown`, `npm run test:nol-tabs`를 순차 실행합니다. NOL 검증은 로컬 fixture를 사용합니다.

버전 태그를 push하면 GitHub Actions가 테스트 → ZIP 검증 → Release 공개를 수행합니다. [배포 방법](../DEPLOYMENT.md)을 참고하세요.

로그인 프로필, 개인 측정 로그, 백업 및 로컬 개발 이력은 저장소와 배포 ZIP에 포함하지 않습니다.
