# CodeBurn 로컬 포크 실행 규칙

- 이 컴퓨터에서 CodeBurn을 실행할 때는 npm 레지스트리 버전이 아니라 이 저장소의 로컬 포크를 사용한다.
- 소스 변경 후에는 저장소 루트에서 `npm run build:cli`와 `npm run build:dash`를 실행한다.
- 빌드가 끝나면 `npm install -g .`로 로컬 포크를 전역 `codeburn` 명령에 반영한다.
- 기본 실행 명령은 `codeburn web`이다. 포트를 지정해야 하면 `codeburn web --port 4747 --no-open`을 사용한다.
- 백엔드(`src`)를 빌드한 경우 `npm run build:cli` 후 반드시 `npm run build:dash`도 실행한다. `build:cli`가 `dist`를 정리하기 때문이다.
- 실행 중인 기존 CodeBurn 서버가 있으면 새 버전 실행 전에 해당 터미널에서 `Ctrl+C`로 종료한다.
