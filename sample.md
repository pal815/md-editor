# md-editor 샘플 문서

이 문서는 **굵게**, *기울임*, ~~취소선~~, `인라인 코드`를 테스트합니다.

## 자동 링크

GFM 자동 링크: https://github.com 또는 https://tauri.app 처럼 벌거벗은 URL도 인식됩니다.

명시적 링크: [Tauri 공식](https://v2.tauri.app)

## Python 코드 블록

```python
def fibonacci(n: int) -> int:
    """피보나치 수를 재귀로 계산."""
    if n < 2:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

for i in range(10):
    print(f"fib({i}) = {fibonacci(i)}")
```

## SQL 코드 블록

```sql
SELECT user_id, COUNT(*) AS post_count
FROM posts
WHERE created_at >= '2025-01-01'
GROUP BY user_id
HAVING COUNT(*) > 10
ORDER BY post_count DESC;
```

## JavaScript / TypeScript

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

async function fetchUser(id: number): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) throw new Error("Not found");
  return res.json();
}
```

## Rust

```rust
fn main() {
    let nums = vec![1, 2, 3, 4, 5];
    let sum: i32 = nums.iter().sum();
    println!("합계 = {}", sum);
}
```

## 일반 텍스트 블록 (text)

```text
이건 그냥 평문이라 색깔은 없지만
코드 블록 스타일은 적용돼야 합니다.
줄바꿈도 보존됨.
```

## 중첩 마크다운 (markdown)

```markdown
# 안쪽 제목
**굵게** 그리고 *기울임*

- 항목 하나
- 항목 둘

`인라인 코드`도 인식됩니다.
```

## 목록

- 첫 번째 항목
- 두 번째 항목
  - 중첩된 항목
- 세 번째 항목

순서 있는 목록:

1. 하나
2. 둘
3. 셋

체크박스:

- [x] 끝낸 작업
- [ ] 남은 작업

## 인용

> 이것은 인용입니다.
> 여러 줄도 가능합니다.

## 표 (Phase 5에서 위젯화 예정)

| 컬럼 A | 컬럼 B | 컬럼 C |
| ------ | ------ | ------ |
| 1      | apple  | 사과   |
| 2      | banana | 바나나 |
