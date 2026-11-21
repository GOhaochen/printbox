package api

import "testing"

func TestParsePageRange(t *testing.T) {
	cases := []struct {
		in    string
		total int
		want  []int
		bad   bool
	}{
		{"", 10, nil, false},
		{"1", 10, []int{1}, false},
		{"1-3", 10, []int{1, 2, 3}, false},
		{"1,3,5", 10, []int{1, 3, 5}, false},
		{"2-4,7", 10, []int{2, 3, 4, 7}, false},
		{"8-20", 10, []int{8, 9, 10}, false},
		{"abc", 10, nil, true},
		{"0", 10, nil, true},
		{"5-2", 10, nil, true},
		{"1-", 10, nil, true},
	}
	for _, c := range cases {
		got, err := parsePageRange(c.in, c.total)
		if c.bad {
			if err == nil {
				t.Errorf("%q 期望报错，却返回 %v", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q 意外报错：%v", c.in, err)
			continue
		}
		if len(got) != len(c.want) {
			t.Errorf("%q 得到 %v，期望 %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%q 得到 %v，期望 %v", c.in, got, c.want)
				break
			}
		}
	}
}
