# GitHub 배포

저장소: https://github.com/bincan98/ticketing

## 다운로드 링크

항상 최신 버전: https://github.com/bincan98/ticketing/releases/latest/download/ticket-click-extension.zip

버전 목록: https://github.com/bincan98/ticketing/releases

소수 사용자에게 배포할 때 이 링크를 전달하면 됩니다. GitHub ZIP 배포에는 Chrome 자동 업데이트가 포함되지 않습니다. 사용자는 기존 폴더의 파일을 교체하고 확장과 페이지를 새로고침합니다.

## 새 버전 배포

1. `manifest.json`, `package.json`, `popup.html`의 표시 버전을 같은 값으로 올립니다.
2. 테스트와 ZIP 검증을 실행합니다.
3. 변경을 commit/push하고 버전 태그를 push합니다.

예시:

```powershell
npm test
npm run package
git add manifest.json package.json popup.html content.js background.js cdp.js
git commit -m "Release 2.2.21"
git push origin main
git tag v2.2.21
git push origin v2.2.21
```

실제 수정한 파일만 검토해 stage합니다. 예시 파일 목록은 매번 변경 내용에 맞춰 조정하세요. 이미 배포한 태그를 강제로 이동하거나 기존 ZIP을 다른 코드로 교체하지 않고 새 버전을 만듭니다.

## Actions 동작

- **Test and package**: main push와 PR에서 단위 테스트 및 패키지 검증, 결과를 단기 artifact로 저장합니다.
- **Publish extension ZIP**: `v*` 태그 push 시 태그·manifest·package·Popup 버전 일치를 확인하고 테스트, ZIP 생성 및 파일별 SHA-256 검증 후 Release를 공개합니다.
- 수동 재실행은 Actions → Publish extension ZIP → Run workflow에서 **이미 존재하는 태그**를 입력합니다. 태그 시점에 워크플로 파일이 있어야 합니다.
- Release는 먼저 draft로 생성해 파일을 첨부한 뒤 공개합니다. 같은 Release가 이미 있으면 기존 파일을 덮어쓰지 않고 실패합니다. draft가 남은 경우 첨부 파일과 실행 로그를 확인해 수동 공개하거나 draft를 정리한 뒤 재실행합니다.
- 워크플로는 GitHub가 발급하는 `GITHUB_TOKEN`을 사용합니다. 저장소에 개인 비밀번호나 토큰을 추가하지 않습니다.
- CI는 Node 단위 테스트를 실행합니다. 실제 Chrome/iframe/2분 대기 및 실제 연습 사이트 측정은 개발 환경에서 별도로 검증합니다.

## 로컬 패키징

```powershell
npm ci --ignore-scripts
npm run package -- --tag v2.2.20
```

`dist`에 버전 ZIP, 고정 이름 ZIP, SHA256SUMS.txt를 만듭니다. 기존 버전 ZIP이 있으면 현재 소스와 10개 항목이 모두 일치할 때만 재사용합니다. 다르면 이전 파일을 보존하고 오류를 표시합니다.

## 공개 범위

실행 소스, 빌드/배포 스크립트, 워크플로, 재현 가능한 테스트와 fixture만 Git으로 관리합니다. 기존 로컬 README/검증 이력, 다운로드 자료, 로그인 프로필, 브라우저 바이너리, 개인 측정 결과, 백업과 ZIP은 로컬에 보존하고 업로드에서 제외합니다. 공개 설치 안내는 `.github/README.md`입니다.
