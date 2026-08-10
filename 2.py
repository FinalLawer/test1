def main():
    print("===== 简易成绩计算器 =====")
    # 获取用户输入三科分数
    chinese = float(input("请输入语文分数："))
    math = float(input("请输入数学分数："))
    english = float(input("请输入英语分数："))

    total = chinese + math + english
    average = total / 3

    print("\n-----成绩汇总-----")
    print(f"总分：{total:.2f}")
    print(f"平均分：{average:.2f}")

    # 判断等级
    if average >= 90:
        print("评级：优秀🎉")
    elif average >= 70:
        print("评级：良好👍")
    elif average >= 60:
        print("评级：及格😐")
    else:
        print("评级：不及格❌")


if __name__ == "__main__":
    main()