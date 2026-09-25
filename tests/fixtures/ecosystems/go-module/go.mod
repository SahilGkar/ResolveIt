module example.com/demo

go 1.22

toolchain go1.22.1

require (
	github.com/spf13/cobra v1.8.0
	golang.org/x/text v0.14.0 // indirect
)

require github.com/stretchr/testify v1.8.4

replace golang.org/x/text => golang.org/x/text v0.15.0

exclude github.com/old/dep v1.0.0
