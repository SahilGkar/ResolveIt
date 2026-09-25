cmake_minimum_required(VERSION 3.27)

project(demo VERSION 1.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_C_STANDARD 17)

find_package(Boost 1.84 COMPONENTS system filesystem REQUIRED)
find_package(OpenSSL)
